import { describe, expect, it } from "vitest";
import { compareSemVer, formatSemVer, parseSemVer } from "./version.js";

describe("parseSemVer", () => {
  it.each([
    ["1.2.3", { major: 1, minor: 2, patch: 3 }],
    ["v1.2.3", { major: 1, minor: 2, patch: 3 }],
    ["0.0.0", { major: 0, minor: 0, patch: 0 }],
    ["10.20.30", { major: 10, minor: 20, patch: 30 }],
    ["  v1.0.0 ", { major: 1, minor: 0, patch: 0 }],
  ])("parses %s", (input, expected) => {
    expect(parseSemVer(input)).toEqual(expected);
  });

  it.each([
    "v1",
    "1",
    "1.2",
    "v1.2",
    "1.2.3-rc.1",
    "1.2.3+build",
    "01.2.3",
    "1.2.3.4",
    "V1.2.3",
    "release-1.2.3",
    "",
    "latest",
  ])("rejects %j", (input) => {
    expect(parseSemVer(input)).toBeNull();
  });
});

describe("compareSemVer", () => {
  const v = (major: number, minor: number, patch: number) => ({ major, minor, patch });

  it("returns zero for equal versions", () => {
    expect(compareSemVer(v(1, 2, 3), v(1, 2, 3))).toBe(0);
  });

  it.each([
    [v(1, 0, 0), v(2, 0, 0)],
    [v(1, 1, 0), v(1, 2, 0)],
    [v(1, 1, 1), v(1, 1, 2)],
    [v(1, 9, 9), v(2, 0, 0)],
    [v(1, 2, 10), v(1, 3, 0)],
  ])("orders %o before %o", (older, newer) => {
    expect(compareSemVer(older, newer)).toBeLessThan(0);
    expect(compareSemVer(newer, older)).toBeGreaterThan(0);
  });

  it("compares numerically, not lexically", () => {
    // "1.10.0" < "1.9.0" as strings, but 10 > 9 as numbers.
    expect(compareSemVer(v(1, 10, 0), v(1, 9, 0))).toBeGreaterThan(0);
    expect(compareSemVer(v(1, 0, 10), v(1, 0, 9))).toBeGreaterThan(0);
  });
});

describe("formatSemVer", () => {
  it("round-trips through parseSemVer", () => {
    expect(formatSemVer({ major: 1, minor: 2, patch: 3 })).toBe("1.2.3");
    expect(parseSemVer(formatSemVer({ major: 4, minor: 5, patch: 6 }))).toEqual({ major: 4, minor: 5, patch: 6 });
  });
});
