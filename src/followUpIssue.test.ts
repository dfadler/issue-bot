import { describe, expect, it } from "vitest";
import {
  backlinkUrl,
  buildIssueBody,
  buildIssueTitle,
  fileIssueFromComment,
  findExistingIssue,
  type OpenIssueSummary,
  type TriggerComment,
} from "./followUpIssue.js";
import type { Octokit } from "./octokit.js";

function notImplemented(name: string): () => never {
  return () => {
    throw new Error(`fake octokit: ${name} was not expected to be called in this test`);
  };
}

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
    const body = "@issue-bot this needs its own tracking, the retry logic silently swallows the underlying error";
    const title = buildIssueTitle(body, "@issue-bot");
    expect(title.startsWith("@issue-bot")).toBe(false);
    expect(title.length).toBeLessThanOrEqual(80);
  });

  it("falls back to a default title when nothing is left after stripping the mention", () => {
    expect(buildIssueTitle("@issue-bot", "@issue-bot")).toBe("Follow-up from PR comment");
  });

  it("uses the first non-empty line", () => {
    const body = "\n\n@issue-bot fix this\nmore detail below";
    expect(buildIssueTitle(body, "@issue-bot")).toBe("fix this");
  });
});

describe("buildIssueBody", () => {
  it("includes the diff hunk section only when path and diffHunk are present", () => {
    const withCode = buildIssueBody({
      comment: {
        id: 1,
        kind: "review",
        author: "octocat",
        body: "@issue-bot look at this",
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
        body: "@issue-bot general comment",
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
        body: "@issue-bot look at this",
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
        body: "@issue-bot look at this",
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

describe("fileIssueFromComment", () => {
  const repoFullName = "owner/repo";
  const prNumber = 42;
  const perPage = 100;

  type FakeIssue = { number: number; html_url: string; body: string | null };

  /**
   * A fake octokit whose `listForRepo` only ever returns one 100-item page
   * at a time - `paginate` walks pages the same way the real
   * `@octokit/plugin-paginate-rest` does, so this only returns every issue
   * (including ones past the first page) if `fileIssueFromComment` actually
   * calls `paginate` instead of `listForRepo` directly. Regression test for
   * https://github.com/dfadler/issue-bot/issues/1.
   */
  function createFakeOctokit(openIssues: FakeIssue[]): Octokit {
    // `paginate` stays fully generic (matching the real interface) and just
    // re-calls `route` with the same params each time - `listForRepo` below
    // tracks which page it's on itself via a closure counter, since the
    // params type it's called with (owner/repo/state/per_page) has nowhere
    // to carry a page number without narrowing the generic `P` in a way
    // that isn't type-safe here.
    let listForRepoCallCount = 0;
    return {
      async paginate<T, P>(route: (params: P) => Promise<{ data: T[] }>, params: P): Promise<T[]> {
        const results: T[] = [];
        for (let i = 0; i < 1000; i += 1) {
          const { data } = await route(params);
          results.push(...data);
          if (data.length < perPage) {
            break;
          }
        }
        return results;
      },
      rest: {
        pulls: {
          listReviewComments: notImplemented("pulls.listReviewComments"),
        },
        issues: {
          listComments: notImplemented("issues.listComments"),
          listForRepo: async () => {
            listForRepoCallCount += 1;
            const start = (listForRepoCallCount - 1) * perPage;
            return { data: openIssues.slice(start, start + perPage) };
          },
          getLabel: async () => undefined,
          createLabel: async () => undefined,
          create: async () => ({
            data: { number: 9999, html_url: `https://github.com/${repoFullName}/issues/9999` },
          }),
        },
      },
    };
  }

  function buildComment(id: number): TriggerComment {
    return {
      id,
      kind: "issue",
      author: "octocat",
      body: "@issue-bot this needs its own issue",
      htmlUrl: `https://github.com/${repoFullName}/pull/${prNumber}#issuecomment-${id}`,
      createdAt: "2026-01-01T00:00:00Z",
    };
  }

  it("finds a backlinked issue beyond the first 100-item page (regression for #1)", async () => {
    const targetCommentId = 555;
    const backlinkBody = `Filed from ${backlinkUrl(repoFullName, prNumber, "issue", targetCommentId)}.`;
    // 150 open issues so the match (at index 120, i.e. issue #121) sits on
    // the second page of a per_page=100 listing.
    const openIssues: FakeIssue[] = Array.from({ length: 150 }, (_, i) => ({
      number: i + 1,
      html_url: `https://github.com/${repoFullName}/issues/${i + 1}`,
      body: i === 120 ? backlinkBody : "unrelated",
    }));

    const result = await fileIssueFromComment({
      octokit: createFakeOctokit(openIssues),
      repoFullName,
      prNumber,
      comment: buildComment(targetCommentId),
      conversation: [],
      mention: "@issue-bot",
      label: "",
    });

    expect(result.filed).toBe(false);
    if (!result.filed) {
      expect(result.existingIssue?.number).toBe(121);
    }
  });

  it("still files a new issue when none of the (many) open issues cover the comment", async () => {
    const openIssues: FakeIssue[] = Array.from({ length: 150 }, (_, i) => ({
      number: i + 1,
      html_url: `https://github.com/${repoFullName}/issues/${i + 1}`,
      body: "unrelated",
    }));

    const result = await fileIssueFromComment({
      octokit: createFakeOctokit(openIssues),
      repoFullName,
      prNumber,
      comment: buildComment(777),
      conversation: [],
      mention: "@issue-bot",
      label: "",
    });

    expect(result.filed).toBe(true);
  });
});
