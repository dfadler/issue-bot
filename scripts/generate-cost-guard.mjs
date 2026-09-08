#!/usr/bin/env node
/*
 * Regenerates the cost-guard `if:` gate embedded in
 * .github/workflows/reusable.yml and the copy-pasteable example in
 * README.md from a single source of truth: the write-access association
 * list in src/authorization.ts, plus the `mention` input's default in
 * action.yml (used for the README's literal example — the reusable
 * workflow references `inputs.mention` directly, so it has no literal to
 * drift). Both targets are otherwise hand-maintained; this only ever
 * rewrites the region between the `cost-guard-if:begin`/`cost-guard-if:end`
 * markers, so surrounding rationale comments and prose are untouched.
 *
 * Run with --check to verify the committed files already match (used in
 * CI) instead of rewriting them.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BEGIN_MARKER = "cost-guard-if:begin";
const END_MARKER = "cost-guard-if:end";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");

function readAuthorizedAssociations() {
  const path = join(repoRoot, "src", "authorization.ts");
  const contents = readFileSync(path, "utf8");
  const setMatch = contents.match(/AUTHORIZED_ASSOCIATIONS[^=]*=\s*new Set\(\[([^\]]*)\]\)/);
  if (!setMatch) {
    throw new Error(`could not find the AUTHORIZED_ASSOCIATIONS Set literal in ${path}`);
  }
  const items = [...setMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (items.length === 0) {
    throw new Error(`AUTHORIZED_ASSOCIATIONS in ${path} parsed to an empty list`);
  }
  return items;
}

// Isolates the top-level `inputs:` block, then the `mention:` sub-block
// within it, the same "isolate the enclosing block first" technique
// check-action-runtime.mjs uses for action.yml's `runs:` block.
function readMentionDefault() {
  const path = join(repoRoot, "action.yml");
  const contents = readFileSync(path, "utf8");
  const inputsBlockMatch = contents.match(/^inputs:\n((?:[ \t].*\n?)*)/m);
  if (!inputsBlockMatch) {
    throw new Error(`could not find a top-level "inputs:" block in ${path}`);
  }
  const mentionBlockMatch = inputsBlockMatch[1].match(/^ {2}mention:\n((?:[ \t]{3,}.*\n?)*)/m);
  if (!mentionBlockMatch) {
    throw new Error(`could not find a "mention:" input in ${path}`);
  }
  const defaultMatch = mentionBlockMatch[1].match(/^\s*default:\s*"([^"]*)"/m);
  if (!defaultMatch) {
    throw new Error(`could not find a "default:" for the "mention" input in ${path}`);
  }
  return defaultMatch[1];
}

function associationClause(associations) {
  return associations.map((a) => `github.event.comment.author_association == '${a}'`).join(" || ");
}

function ifExpressionLines({ indent, mentionExpr, associations }) {
  const inner = `${indent}  `;
  return [
    `${indent}if: >-`,
    `${inner}contains(github.event.comment.body, ${mentionExpr}) &&`,
    `${inner}(github.event_name != 'issue_comment' || github.event.issue.pull_request != null) &&`,
    `${inner}github.event.comment.user.type != 'Bot' &&`,
    `${inner}(${associationClause(associations)})`,
  ];
}

function spliceBetweenMarkers(text, label, newInnerLines) {
  const lines = text.split("\n");
  const beginIdx = lines.findIndex((line) => line.includes(BEGIN_MARKER));
  if (beginIdx === -1) {
    throw new Error(`could not find a "${BEGIN_MARKER}" marker in ${label}`);
  }
  const endIdx = lines.findIndex((line, i) => i > beginIdx && line.includes(END_MARKER));
  if (endIdx === -1) {
    throw new Error(`could not find a "${END_MARKER}" marker after the begin marker in ${label}`);
  }
  const before = lines.slice(0, beginIdx + 1);
  const after = lines.slice(endIdx);
  return [...before, ...newInnerLines, ...after].join("\n");
}

function buildReusableWorkflow(text, associations) {
  const inner = ifExpressionLines({ indent: "    ", mentionExpr: "inputs.mention", associations });
  return spliceBetweenMarkers(text, ".github/workflows/reusable.yml", inner);
}

function buildReadme(text, associations, mentionDefault) {
  const ifLines = ifExpressionLines({ indent: "      ", mentionExpr: `'${mentionDefault}'`, associations });
  const inner = [
    "  ```yaml",
    "  jobs:",
    "    issue-bot:",
    ...ifLines,
    "      runs-on: ubuntu-latest",
    "      permissions:",
    "        issues: write",
    "        pull-requests: write",
    "      steps:",
    "        - uses: dfadler/issue-bot@v1 # pin to a commit SHA instead — see note below",
    "  ```",
  ];
  return spliceBetweenMarkers(text, "README.md", inner);
}

function main() {
  const checkOnly = process.argv.includes("--check");

  const associations = readAuthorizedAssociations();
  const mentionDefault = readMentionDefault();

  const targets = [
    { path: join(repoRoot, ".github", "workflows", "reusable.yml"), build: (text) => buildReusableWorkflow(text, associations) },
    { path: join(repoRoot, "README.md"), build: (text) => buildReadme(text, associations, mentionDefault) },
  ];

  let stale = false;
  for (const { path, build } of targets) {
    const original = readFileSync(path, "utf8");
    const updated = build(original);
    if (updated === original) {
      console.log(`ok: ${path} is up to date`);
      continue;
    }
    if (checkOnly) {
      console.error(`error: ${path} is stale relative to src/authorization.ts / action.yml — run \`npm run generate:cost-guard\` and commit the result`);
      stale = true;
      continue;
    }
    writeFileSync(path, updated);
    console.log(`updated: ${path}`);
  }

  if (checkOnly && stale) {
    process.exit(1);
  }
}

try {
  main();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
