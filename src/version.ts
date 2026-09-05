/**
 * The minimal semver this repo needs: the release workflow only ever
 * publishes plain `MAJOR.MINOR.PATCH` versions (it rejects anything else
 * before tagging - see .github/workflows/release.yml), so prerelease and
 * build-metadata suffixes are deliberately not modelled. Hand-rolled rather
 * than pulling in the `semver` package for a three-field numeric compare.
 */
export type SemVer = { major: number; minor: number; patch: number };

/**
 * Accepts an optional leading `v` so the same parser handles both the
 * release workflow's bare `1.2.3` input and the `v1.2.3` tag it publishes.
 * Major-only tags like `v1` (the moving alias the workflow also maintains)
 * are rejected - they don't identify a release.
 */
const SEMVER_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseSemVer(value: string): SemVer | null {
  const match = SEMVER_PATTERN.exec(value.trim());
  if (match === null) {
    return null;
  }
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    return null;
  }
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

/** Negative when `a` is older than `b`, positive when newer, zero when equal. */
export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  return a.patch - b.patch;
}

export function formatSemVer(version: SemVer): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}
