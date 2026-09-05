#!/usr/bin/env node
/*
 * Bundles src/index.ts into dist/index.js.
 *
 * The one thing this does beyond a plain esbuild invocation is stamp the
 * release version into the bundle: `ISSUE_BOT_VERSION` (set by
 * .github/workflows/release.yml from its `version` input) is baked in as
 * the literal value of `process.env.ISSUE_BOT_VERSION`, which
 * src/versionCheck.ts reads to learn which release the running action was
 * built as. Baking it in - rather than reading the environment at runtime -
 * is what makes the version check correct for a consumer pinned to a
 * commit SHA: the SHA carries no version in its ref name, but the bundle at
 * that SHA does.
 *
 * Without the variable set (CI's build check, a local `npm run build`), an
 * empty string is stamped and the action treats itself as a dev build:
 * the version check warns and skips instead of comparing.
 */

import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.env.ISSUE_BOT_VERSION ?? "";

if (version !== "" && !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`error: ISSUE_BOT_VERSION must be MAJOR.MINOR.PATCH without a leading "v" (e.g. 1.2.3), got: ${version}`);
  process.exit(1);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  absWorkingDir: repoRoot,
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  outfile: "dist/index.js",
  banner: {
    js: "import{createRequire as __createRequire}from'module';const require=__createRequire(import.meta.url);",
  },
  define: {
    "process.env.ISSUE_BOT_VERSION": JSON.stringify(version),
  },
  logLevel: "info",
});

console.log(
  version === ""
    ? "built dist/index.js as a dev build (ISSUE_BOT_VERSION unset; the runtime version check will skip itself)"
    : `built dist/index.js as issue-bot ${version}`,
);
