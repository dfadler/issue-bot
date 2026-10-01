import { describe, expect, it } from "vitest";
import { checkText, parsePins, tagForSha } from "./check-action-pin-comments.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

// Hermetic stand-in for `git ls-remote`: no network.
const tags = new Map([
  ["v1", SHA_A],
  ["v1.2", SHA_A],
  ["v1.2.3", SHA_A],
  ["v2.0.0", SHA_B],
]);
const fetchTags = () => tags;

const wf = (line) => `steps:\n  ${line}\n`;
const run = (line, opts) => checkText(wf(line), "wf.yml", fetchTags, opts);

describe("checkText", () => {
  it("passes when the comment names a tag at the SHA", () => {
    expect(run(`- uses: acme/tool@${SHA_A} # v1.2.3`).findings).toEqual([]);
  });

  it("passes for a sub-path action and a plain `uses:` key", () => {
    expect(run(`uses: acme/tool/init@${SHA_B} # v2.0.0`).findings).toEqual([]);
  });

  it("flags a comment whose tag points at a different SHA, naming the real tag", () => {
    const { findings } = run(`- uses: acme/tool@${SHA_A} # v2.0.0`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "mismatch", file: "wf.yml", line: 2 });
    expect(findings[0].message).toContain(`resolves to ${SHA_B}`);
    expect(findings[0].message).toContain("tag v1.2.3");
  });

  it("flags a comment naming a tag that does not exist", () => {
    const { findings } = run(`- uses: acme/tool@${SHA_A} # v9.9.9`);
    expect(findings[0].kind).toBe("mismatch");
    expect(findings[0].message).toContain("does not exist");
  });

  it("flags a missing version comment", () => {
    expect(run(`- uses: acme/tool@${SHA_A}`).findings[0].kind).toBe("missing-comment");
  });

  it("flags a comment that is not a version", () => {
    expect(run(`- uses: acme/tool@${SHA_A} # pinned for safety`).findings[0].kind).toBe("bad-comment");
  });

  it("flags a mutable ref", () => {
    expect(run("- uses: acme/tool@v4").findings[0].kind).toBe("mutable-ref");
    expect(run("- uses: acme/tool@main").findings[0].kind).toBe("mutable-ref");
  });

  it("accepts a trailing note after the version", () => {
    expect(run(`- uses: acme/tool@${SHA_A} # v1.2.3 (security fix)`).findings).toEqual([]);
  });

  it("reports a tag-listing failure instead of passing silently", () => {
    const boom = () => {
      throw new Error("network down\nstack");
    };
    const { findings } = checkText(wf(`- uses: acme/tool@${SHA_A} # v1.2.3`), "wf.yml", boom);
    expect(findings[0]).toMatchObject({ kind: "lookup-error" });
    expect(findings[0].message).toContain("network down");
  });

  it("matches an annotated tag via the peeled commit", () => {
    // lsRemoteTags stores the peeled commit under the tag name, so a Map
    // built that way resolves by commit SHA exactly like a lightweight tag.
    const peeled = new Map([["v3.0.0", SHA_B]]);
    const { findings } = checkText(wf(`- uses: acme/tool@${SHA_B} # v3.0.0`), "wf.yml", () => peeled);
    expect(findings).toEqual([]);
  });
});

describe("parsePins", () => {
  it("skips local, docker, placeholder, and commented-out uses", () => {
    const text = [
      "- uses: ./local",
      "- uses: docker://alpine:3",
      "- uses: dfadler/issue-bot@__SHA__ # __FULL__",
      "# - uses: acme/tool@v1",
      `- uses: acme/real@${SHA_A} # v1`,
    ].join("\n");
    expect(parsePins(text).map((p) => p.action)).toEqual(["acme/real"]);
  });
});

describe("--fix", () => {
  it("rewrites only the comment to the most specific matching tag", () => {
    const line = `- uses: acme/tool@${SHA_A} # v2.0.0`;
    const { fixed, findings } = run(line, { fix: true });
    expect(findings).toEqual([]);
    expect(fixed).toContain(`- uses: acme/tool@${SHA_A} # v1.2.3`);
  });

  it("never rewrites the SHA, and leaves unfixable mismatches reported", () => {
    const orphan = "c".repeat(40);
    const { fixed, findings } = run(`- uses: acme/tool@${orphan} # v1.2.3`, { fix: true });
    expect(fixed).toBeNull();
    expect(findings[0].kind).toBe("mismatch");
  });
});

describe("tagForSha", () => {
  it("prefers the most specific version tag", () => {
    expect(tagForSha(tags, SHA_A)).toBe("v1.2.3");
    expect(tagForSha(tags, "c".repeat(40))).toBeNull();
  });
});
