import * as core from "@actions/core";
import type { Octokit } from "./octokit.js";
import { compareSemVer, formatSemVer, parseSemVer, type SemVer } from "./version.js";

/**
 * The repo whose release tags define "the latest release". Hardcoded to the
 * canonical upstream rather than derived from the consumer's workflow: the
 * action can't see its own `uses:` line, and a consumer pinned to a commit
 * SHA has no ref name to inspect anyway.
 */
export const UPSTREAM_OWNER = "dfadler";
export const UPSTREAM_REPO = "issue-bot";

const README_ANCHOR = "https://github.com/dfadler/issue-bot#version-check";

export type VersionCheckMode = "fail" | "warn" | "off";

const VERSION_CHECK_MODES: ReadonlySet<string> = new Set(["fail", "warn", "off"]);

export function parseVersionCheckMode(value: string): VersionCheckMode | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "fail" || normalized === "warn" || normalized === "off") {
    return normalized;
  }
  return null;
}

export function versionCheckModeList(): string {
  return [...VERSION_CHECK_MODES].join(", ");
}

/**
 * The release version this bundle was built as. `scripts/build.mjs` bakes
 * `ISSUE_BOT_VERSION` into the bundle via an esbuild `define`, so at runtime
 * this is a string literal - not a lookup of the consumer's environment,
 * which is what makes it correct for a consumer pinned to a commit SHA (the
 * SHA has no version in its ref name, but the bundle at that SHA knows what
 * it was released as). A build without the variable set (CI, a local
 * `npm run build`, or the tests) yields `undefined` here.
 */
export function builtVersion(): string | undefined {
  const value = process.env.ISSUE_BOT_VERSION;
  return value !== undefined && value.length > 0 ? value : undefined;
}

export type LatestRelease = { version: SemVer; tag: string; sha: string };

/**
 * The narrow slice of `Octokit` the version check needs - so a test can
 * fake just `paginate` + `repos.listTags` without populating every method
 * the full type declares. The real client satisfies this structurally.
 */
export type VersionCheckOctokit = {
  paginate: Octokit["paginate"];
  rest: { repos: Octokit["rest"]["repos"] };
};

/**
 * The highest `vX.Y.Z` tag on the upstream repo. Tags rather than GitHub
 * Releases because the release workflow publishes by force-moving tags
 * (`v1.2.3` and the `v1` alias) and never creates a Release object - the
 * one Release that exists is hand-made and tagged only `v1`, which
 * identifies a major line, not a version. Major-only aliases are skipped by
 * `parseSemVer`.
 */
export async function fetchLatestRelease(octokit: VersionCheckOctokit): Promise<LatestRelease | null> {
  const tags = await octokit.paginate(octokit.rest.repos.listTags, {
    owner: UPSTREAM_OWNER,
    repo: UPSTREAM_REPO,
    per_page: 100,
  });
  let latest: LatestRelease | null = null;
  for (const tag of tags) {
    const version = parseSemVer(tag.name);
    if (version === null) {
      continue;
    }
    if (latest === null || compareSemVer(version, latest.version) > 0) {
      latest = { version, tag: tag.name, sha: tag.commit.sha };
    }
  }
  return latest;
}

export type VersionCheckOutcome =
  | { status: "current"; running: SemVer; latest: LatestRelease }
  | { status: "stale"; running: SemVer; latest: LatestRelease; message: string }
  | { status: "skipped"; reason: string };

export function buildStaleMessage(running: SemVer, latest: LatestRelease): string {
  return [
    `issue-bot v${formatSemVer(running)} is running, but v${formatSemVer(latest.version)} is the latest release. Update the \`uses:\` line in your workflow to:`,
    "",
    `    uses: ${UPSTREAM_OWNER}/${UPSTREAM_REPO}@${latest.sha} # ${latest.tag}`,
    "",
    `(or \`uses: ${UPSTREAM_OWNER}/${UPSTREAM_REPO}@${latest.tag}\` if you don't pin to a commit SHA). ` +
      "An out-of-date pin can silently change what the action does - e.g. an older `mention` default that never matches " +
      "(https://github.com/dfadler/zombie-mermaid/issues/358) - which is why this check fails by default. " +
      `Set the \`version-check\` input to \`warn\` or \`off\` to relax it: ${README_ANCHOR}`,
  ].join("\n");
}

/**
 * Pure decision step, separated from the API call and the `@actions/core`
 * reporting so it's directly testable. A running version the bundle
 * doesn't know (dev build) or an upstream with no semver tags both skip
 * rather than fail - neither is a stale consumer, which is the only thing
 * this check is meant to catch.
 */
export function evaluateVersion(runningVersion: string | undefined, latest: LatestRelease | null): VersionCheckOutcome {
  if (runningVersion === undefined) {
    return {
      status: "skipped",
      reason: "this issue-bot bundle was built without a release version (a local or CI build, not a release ref); skipping the version check.",
    };
  }
  const running = parseSemVer(runningVersion);
  if (running === null) {
    return {
      status: "skipped",
      reason: `this issue-bot bundle's embedded version "${runningVersion}" is not MAJOR.MINOR.PATCH; skipping the version check.`,
    };
  }
  if (latest === null) {
    return {
      status: "skipped",
      reason: `no vX.Y.Z release tags found on ${UPSTREAM_OWNER}/${UPSTREAM_REPO}; skipping the version check.`,
    };
  }
  if (compareSemVer(running, latest.version) < 0) {
    return { status: "stale", running, latest, message: buildStaleMessage(running, latest) };
  }
  return { status: "current", running, latest };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the version check and reports through `@actions/core` according to
 * `mode`. Returns whether the action should go on to handle the event:
 * only a `fail`-mode stale result stops it. Anything that prevents the
 * comparison from happening at all - a network error, a rate limit, a
 * token that can't read the upstream repo - is a warning, never a failure:
 * a transient outage upstream must not break a consumer's issue filing.
 */
export async function runVersionCheck(
  octokit: VersionCheckOctokit,
  mode: VersionCheckMode,
  runningVersion: string | undefined,
): Promise<boolean> {
  if (mode === "off") {
    core.info("version-check is off; skipping.");
    return true;
  }

  let latest: LatestRelease | null;
  try {
    latest = await fetchLatestRelease(octokit);
  } catch (error) {
    core.warning(
      `Could not look up the latest ${UPSTREAM_OWNER}/${UPSTREAM_REPO} release (${describeError(error)}); skipping the version check.`,
    );
    return true;
  }

  const outcome = evaluateVersion(runningVersion, latest);
  switch (outcome.status) {
    case "skipped":
      core.warning(`version-check: ${outcome.reason}`);
      return true;
    case "current":
      core.info(
        `issue-bot v${formatSemVer(outcome.running)} is up to date (latest release: ${outcome.latest.tag}).`,
      );
      return true;
    case "stale":
      if (mode === "fail") {
        core.setFailed(outcome.message);
        return false;
      }
      core.warning(outcome.message);
      return true;
  }
}
