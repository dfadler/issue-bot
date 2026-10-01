#!/usr/bin/env node
/*
 * Verifies that every SHA-pinned `uses:` line under .github/ (and the root
 * action.yml) carries a trailing version comment that names a tag really
 * pointing at that commit:
 *
 *   uses: actions/checkout@<40-hex-sha> # v7.0.1
 *
 * A comment that drifts from its SHA (a hand-edit of one side, a
 * copy-paste) misleads reviewers who trust it instead of resolving the SHA
 * themselves. Also fails on a pinned `uses:` with no version comment, an
 * unparseable comment, and a `uses:` pinned to a mutable ref (tag/branch).
 *
 * Tags are read with `git ls-remote --tags` against the action's repo, so
 * no token is needed. Annotated tags are peeled to the commit they point at.
 *
 * --check (default): report problems, exit 1 if any.
 * --fix: rewrite a wrong comment to the most specific tag that does point at
 *        the SHA. Never rewrites the SHA itself (that changes what runs).
 *        Missing/unparseable comments and mutable refs are not auto-fixed.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { execFileSync } from "node:child_process";

const SHA_RE = /^[0-9a-f]{40}$/;
// `  - uses: owner/repo/path@ref # comment` (the `- ` and comment are optional).
const USES_RE = /^(\s*(?:-\s+)?uses:\s*)(\S+?)@(\S+?)(?:(\s+)#\s*(.*?))?\s*$/;
// First token of the comment must look like a version tag: v7.0.1, 1.2, v4.
const VERSION_RE = /^v?\d+(?:\.\d+){0,2}(?:[-+][\w.]+)?$/;
// Template placeholders (release.yml's heredoc) are not real refs.
const PLACEHOLDER_RE = /^(?:__\w+__|<[^>]*>)$/;

export function repoOf(action) {
  return action.split("/").slice(0, 2).join("/");
}

/** Pulls `uses:` pins out of one file's text. Skips local/docker/placeholder refs. */
export function parsePins(text) {
  const pins = [];
  text.split("\n").forEach((raw, index) => {
    const m = USES_RE.exec(raw);
    if (!m) return;
    const [, , action, ref, , comment] = m;
    if (action.startsWith("./") || action.startsWith("docker://")) return;
    if (PLACEHOLDER_RE.test(ref)) return;
    pins.push({ line: index + 1, action, ref, comment: comment ?? null });
  });
  return pins;
}

/** Runs `git ls-remote --tags` and returns Map<tag, commitSha> (peeled for annotated tags). */
export function lsRemoteTags(repo) {
  const out = execFileSync("git", ["ls-remote", "--tags", `https://github.com/${repo}`], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tags = new Map();
  for (const row of out.split("\n")) {
    const [sha, ref] = row.split("\t");
    if (!sha || !ref?.startsWith("refs/tags/")) continue;
    const name = ref.slice("refs/tags/".length);
    if (name.endsWith("^{}")) {
      tags.set(name.slice(0, -3), sha); // peeled commit wins over the tag object
    } else if (!tags.has(name)) {
      tags.set(name, sha);
    }
  }
  return tags;
}

function specificity(tag) {
  return (tag.match(/\./g) ?? []).length;
}

/** Most specific version-looking tag pointing at `sha`, or null. */
export function tagForSha(tags, sha) {
  const candidates = [...tags].filter(([tag, s]) => s === sha && VERSION_RE.test(tag)).map(([tag]) => tag);
  candidates.sort((a, b) => specificity(b) - specificity(a) || a.localeCompare(b));
  return candidates[0] ?? null;
}

/**
 * Checks one file's text. `fetchTags(repo)` returns Map<tag, sha>.
 * Returns {findings, fixed} where `fixed` is the rewritten text when `fix`
 * repaired at least one comment (else null).
 */
export function checkText(text, file, fetchTags, { fix = false } = {}) {
  const findings = [];
  const lines = text.split("\n");
  let changed = false;

  for (const pin of parsePins(text)) {
    const at = (kind, message) => findings.push({ file, line: pin.line, kind, message });
    const where = `${pin.action}@${pin.ref}`;

    if (!SHA_RE.test(pin.ref)) {
      at("mutable-ref", `${where} is pinned to a mutable ref; pin to a full commit SHA with a version comment`);
      continue;
    }
    if (pin.comment === null || pin.comment === "") {
      at("missing-comment", `${where} has no version comment (expected \`# vX.Y.Z\`)`);
      continue;
    }
    const version = pin.comment.split(/\s+/)[0];
    if (!VERSION_RE.test(version)) {
      at("bad-comment", `${where} has comment "# ${pin.comment}" that does not start with a version tag`);
      continue;
    }

    let tags;
    try {
      tags = fetchTags(repoOf(pin.action));
    } catch (error) {
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      at("lookup-error", `could not list tags for ${repoOf(pin.action)}: ${reason}`);
      continue;
    }

    const resolved = tags.get(version);
    if (resolved === pin.ref) continue;

    const actual = tagForSha(tags, pin.ref);
    const detail =
      resolved === undefined
        ? `tag ${version} does not exist in ${repoOf(pin.action)}`
        : `tag ${version} resolves to ${resolved}`;
    if (fix && actual) {
      const idx = pin.line - 1;
      lines[idx] = lines[idx].replace(/(#\s*)\S+/, `$1${actual}`);
      changed = true;
      continue;
    }
    at(
      "mismatch",
      `${where} is commented "# ${version}" but ${detail}; the SHA is ${actual ? `tag ${actual}` : "not any release tag"}`,
    );
  }

  return { findings, fixed: changed ? lines.join("\n") : null };
}

/** Workflow/action files to scan, as absolute paths under repoRoot. */
export function listFiles(repoRoot) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.ya?ml$/.test(name)) out.push(full);
    }
  };
  const github = join(repoRoot, ".github");
  if (existsSync(github)) walk(github);
  for (const name of ["action.yml", "action.yaml"]) {
    if (existsSync(join(repoRoot, name))) out.push(join(repoRoot, name));
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(
      "usage: check-action-pin-comments.mjs [--check | --fix]\nVerifies `uses: x@<sha> # vX.Y.Z` comments match the pinned commit.",
    );
    return;
  }
  const fix = args.includes("--fix");
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const cache = new Map();
  const fetchTags = (repo) => {
    if (!cache.has(repo)) cache.set(repo, lsRemoteTags(repo));
    return cache.get(repo);
  };

  const all = [];
  for (const path of listFiles(repoRoot)) {
    const text = readFileSync(path, "utf8");
    const { findings, fixed } = checkText(text, relative(repoRoot, path), fetchTags, { fix });
    all.push(...findings);
    if (fixed !== null) {
      writeFileSync(path, fixed);
      console.log(`fixed: ${relative(repoRoot, path)}`);
    }
  }

  for (const f of all) console.error(`${f.file}:${f.line}: [${f.kind}] ${f.message}`);
  if (all.length > 0) {
    const hint = fix ? " remain after --fix" : " (run `npm run check:action-pins -- --fix` for wrong comments)";
    console.error(`error: ${all.length} action pin problem(s)${hint}`);
    process.exit(1);
  }
  console.log("ok: all action pin comments match their SHAs");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
