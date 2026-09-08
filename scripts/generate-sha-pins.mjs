#!/usr/bin/env node
/*
 * Rewrites README.md's "pin to a commit SHA" examples
 * (`dfadler/issue-bot@<sha> # <tag>`) to the real, current commit SHA for
 * whichever tag each example names in its trailing comment, instead of
 * leaving a literal `<commit-sha>` placeholder for readers to fill in
 * themselves. Tags are read from this checkout's own git refs — `v1` moves
 * with every release (see the Releasing section), so this has to be
 * re-run whenever that happens, not just once; the Release workflow does
 * that automatically after tagging.
 *
 * Run with --check to verify README.md already matches the current tags
 * (used in CI) instead of rewriting it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const readmePath = join(repoRoot, "README.md");

const shaCache = new Map();

function resolveTagSha(tag) {
  if (shaCache.has(tag)) {
    return shaCache.get(tag);
  }
  let sha;
  try {
    sha = execFileSync("git", ["rev-parse", tag], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      `could not resolve tag "${tag}" to a commit — is it fetched? (CI needs \`fetch-tags: true\` / \`fetch-depth: 0\` on the checkout step)`,
    );
  }
  shaCache.set(tag, sha);
  return sha;
}

// Matches `dfadler/issue-bot@<sha-token> # <tag>` where <sha-token> is
// either a placeholder (`<commit-sha>`, `<sha-of-v1.2.0>`, ...) or an
// already-resolved hex SHA from a previous run, and <tag> is the release
// tag (e.g. `v1`, `v1.2.0`) that SHA is supposed to pin to. Reusing the
// same rule for both shapes makes regeneration idempotent: a stale real
// SHA gets overwritten by a fresh `git rev-parse`, the same as a
// placeholder does.
const PIN_WITH_COMMENT_RE = /(dfadler\/issue-bot@)(?:<[^>]+>|[0-9a-f]{7,40})(\s*#\s*(v\d+(?:\.\d+\.\d+)?))/g;

// The reusable workflow's `with.ref` example has no trailing version
// comment to name its tag from — it always pins the default ref, `v1`.
const REF_INPUT_RE = /(ref:\s*")(?:<[^>]+>|[0-9a-f]{7,40})(")/g;

function buildReadme(text) {
  let updated = text.replace(PIN_WITH_COMMENT_RE, (_match, prefix, suffix, tag) => {
    return `${prefix}${resolveTagSha(tag)}${suffix}`;
  });
  updated = updated.replace(REF_INPUT_RE, (_match, prefix, suffix) => {
    return `${prefix}${resolveTagSha("v1")}${suffix}`;
  });
  return updated;
}

function main() {
  const checkOnly = process.argv.includes("--check");

  const original = readFileSync(readmePath, "utf8");
  const updated = buildReadme(original);

  if (updated === original) {
    console.log(`ok: ${readmePath} is up to date`);
    return;
  }

  if (checkOnly) {
    console.error(
      `error: ${readmePath} has stale commit-SHA pins relative to this checkout's tags — run \`npm run generate:sha-pins\` and commit the result`,
    );
    process.exit(1);
  }

  writeFileSync(readmePath, updated);
  console.log(`updated: ${readmePath}`);
}

try {
  main();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
