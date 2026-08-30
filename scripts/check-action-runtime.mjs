#!/usr/bin/env node
/*
 * Validates action.yml's `runs.using` value against the runtimes GitHub
 * Actions currently accepts. This is plain YAML config, so tsc/oxlint/vitest
 * never touch it — a bad value (e.g. "node22", which is not a real runtime)
 * only surfaces when a consumer workflow tries to load the action and fails
 * at runtime. Parsed with a regex instead of a YAML dependency: action.yml's
 * `runs:` block is simple enough that pulling in a parser isn't worth it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const VALID_RUNTIMES = new Set(["docker", "node16", "node20", "node24"]);
const DEPRECATED_RUNTIMES = new Set(["node12"]);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const actionYmlPath = join(scriptDir, "..", "action.yml");

const contents = readFileSync(actionYmlPath, "utf8");

// Isolate the `runs:` top-level block so we only look at `using:` within it,
// not some unrelated key elsewhere in the file that happens to be named the
// same.
const runsBlockMatch = contents.match(/^runs:\n((?:[ \t].*\n?)*)/m);
if (!runsBlockMatch) {
  console.error(`error: action.yml has no top-level "runs:" block (${actionYmlPath})`);
  process.exit(1);
}

const usingMatch = runsBlockMatch[1].match(/^\s*using:\s*["']?([\w-]+)["']?\s*$/m);
if (!usingMatch) {
  console.error(`error: could not find "using:" under "runs:" in action.yml (${actionYmlPath})`);
  process.exit(1);
}

const using = usingMatch[1];

if (DEPRECATED_RUNTIMES.has(using)) {
  console.error(
    `error: action.yml runs.using is "${using}", which GitHub Actions no longer accepts for new or updated actions.\n` +
      `Valid runtimes: ${[...VALID_RUNTIMES].join(", ")}`,
  );
  process.exit(1);
}

if (!VALID_RUNTIMES.has(using)) {
  console.error(
    `error: action.yml runs.using is "${using}", which is not a known GitHub Actions runtime.\n` +
      `Valid runtimes: ${[...VALID_RUNTIMES].join(", ")}`,
  );
  process.exit(1);
}

console.log(`ok: action.yml runs.using is "${using}"`);
