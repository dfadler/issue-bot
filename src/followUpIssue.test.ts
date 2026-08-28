import { describe, expect, it } from "vitest";
import {
  backlinkUrl,
  buildIssueBody,
  buildIssueTitle,
  findExistingIssue,
  type OpenIssueSummary,
} from "./followUpIssue.js";

describe("backlinkUrl", () => {
  it("builds a discussion permalink for review comments", () => {
    expect(backlinkUrl("owner/repo", 42, "review", 100)).toBe(
      "https://github.com/owner/repo/pull/42#discussion_r100",
    );
  });

  it("builds an issue-comment permalink for issue comments", () => {
    expect(backlinkUrl("owner/repo", 42, "issue", 5)).toBe(
      "https://github.com/owner/repo/pull/42#issuecomment-5",
    );
  });
});

describe("findExistingIssue", () => {
  const repoFullName = "owner/repo";
  const prNumber = 42;

  it("finds an issue that already backlinks the exact review comment", () => {
    const issues: OpenIssueSummary[] = [
      { number: 1, url: "https://github.com/owner/repo/issues/1", body: "unrelated" },
      {
        number: 2,
        url: "https://github.com/owner/repo/issues/2",
        body: `Filed from ${backlinkUrl(repoFullName, prNumber, "review", 100)}.`,
      },
    ];
    const found = findExistingIssue(issues, repoFullName, prNumber, "review", 100);
    expect(found?.number).toBe(2);
  });

  it("does not false-positive on a numeric substring (100 vs 1004)", () => {
    const issues: OpenIssueSummary[] = [
      {
        number: 3,
        url: "https://github.com/owner/repo/issues/3",
        body: `Filed from ${backlinkUrl(repoFullName, prNumber, "review", 1004)}.`,
      },
    ];
    expect(findExistingIssue(issues, repoFullName, prNumber, "review", 100)).toBeNull();
  });

  it("does not false-positive on a numeric substring for issue comments (5 vs 55)", () => {
    const issues: OpenIssueSummary[] = [
      {
        number: 4,
        url: "https://github.com/owner/repo/issues/4",
        body: `Filed from ${backlinkUrl(repoFullName, prNumber, "issue", 55)}.`,
      },
    ];
    expect(findExistingIssue(issues, repoFullName, prNumber, "issue", 5)).toBeNull();
  });

  it("does not match a review-comment backlink against an issue-comment lookup", () => {
    const issues: OpenIssueSummary[] = [
      {
        number: 5,
        url: "https://github.com/owner/repo/issues/5",
        body: `Filed from ${backlinkUrl(repoFullName, prNumber, "review", 100)}.`,
      },
    ];
    expect(findExistingIssue(issues, repoFullName, prNumber, "issue", 100)).toBeNull();
  });

  it("returns null when no open issue covers this comment", () => {
    expect(findExistingIssue([], repoFullName, prNumber, "review", 100)).toBeNull();
  });
});

describe("buildIssueTitle", () => {
  it("strips the mention and truncates to 80 chars", () => {
    const body = "@dfadler-issue-bot this needs its own tracking, the retry logic silently swallows the underlying error";
    const title = buildIssueTitle(body, "@dfadler-issue-bot");
    expect(title.startsWith("@dfadler-issue-bot")).toBe(false);
    expect(title.length).toBeLessThanOrEqual(80);
  });

  it("falls back to a default title when nothing is left after stripping the mention", () => {
    expect(buildIssueTitle("@dfadler-issue-bot", "@dfadler-issue-bot")).toBe("Follow-up from PR comment");
  });

  it("uses the first non-empty line", () => {
    const body = "\n\n@dfadler-issue-bot fix this\nmore detail below";
    expect(buildIssueTitle(body, "@dfadler-issue-bot")).toBe("fix this");
  });
});

describe("buildIssueBody", () => {
  it("includes the diff hunk section only when path and diffHunk are present", () => {
    const withCode = buildIssueBody({
      comment: {
        id: 1,
        kind: "review",
        author: "octocat",
        body: "@dfadler-issue-bot look at this",
        htmlUrl: "https://github.com/owner/repo/pull/1#discussion_r1",
        createdAt: "2026-01-01T00:00:00Z",
        path: "src/foo.ts",
        diffHunk: "@@ -1,2 +1,2 @@\n-old\n+new",
      },
      repoFullName: "owner/repo",
      prNumber: 1,
      conversation: [],
    });
    expect(withCode).toContain("### Related code (`src/foo.ts`)");
    expect(withCode).toContain("+new");

    const withoutCode = buildIssueBody({
      comment: {
        id: 2,
        kind: "issue",
        author: "octocat",
        body: "@dfadler-issue-bot general comment",
        htmlUrl: "https://github.com/owner/repo/pull/1#issuecomment-2",
        createdAt: "2026-01-01T00:00:00Z",
      },
      repoFullName: "owner/repo",
      prNumber: 1,
      conversation: [],
    });
    expect(withoutCode).not.toContain("### Related code");
  });

  it("includes conversation entries when present", () => {
    const body = buildIssueBody({
      comment: {
        id: 1,
        kind: "review",
        author: "octocat",
        body: "@dfadler-issue-bot look at this",
        htmlUrl: "https://github.com/owner/repo/pull/1#discussion_r1",
        createdAt: "2026-01-01T00:00:00Z",
      },
      repoFullName: "owner/repo",
      prNumber: 1,
      conversation: [{ author: "reviewer", body: "agreed, this is out of scope", createdAt: "2026-01-01T00:00:00Z" }],
    });
    expect(body).toContain("### Conversation");
    expect(body).toContain("**reviewer**: agreed, this is out of scope");
  });

  it("always includes the backlink footer", () => {
    const body = buildIssueBody({
      comment: {
        id: 7,
        kind: "review",
        author: "octocat",
        body: "@dfadler-issue-bot look at this",
        htmlUrl: "https://github.com/owner/repo/pull/1#discussion_r7",
        createdAt: "2026-01-01T00:00:00Z",
      },
      repoFullName: "owner/repo",
      prNumber: 1,
      conversation: [],
    });
    expect(body).toContain(backlinkUrl("owner/repo", 1, "review", 7));
  });
});
