import { describe, expect, it } from "vitest";
import { collectThreadComments, fetchPullRequestSummary, threadRootId, type ThreadableComment } from "./threadContext.js";
import type { Octokit } from "./octokit.js";

describe("threadRootId", () => {
  it("returns the comment itself when it has no parent", () => {
    const byId = new Map<number, ThreadableComment>([[1, { id: 1 }]]);
    expect(threadRootId(1, byId)).toBe(1);
  });

  it("resolves a direct reply to its root", () => {
    const byId = new Map<number, ThreadableComment>([
      [1, { id: 1 }],
      [2, { id: 2, in_reply_to_id: 1 }],
    ]);
    expect(threadRootId(2, byId)).toBe(1);
  });

  it("walks a multi-hop chain to the root", () => {
    const byId = new Map<number, ThreadableComment>([
      [1, { id: 1 }],
      [2, { id: 2, in_reply_to_id: 1 }],
      [3, { id: 3, in_reply_to_id: 2 }],
    ]);
    expect(threadRootId(3, byId)).toBe(1);
  });

  it("does not infinite-loop on a cycle", () => {
    const byId = new Map<number, ThreadableComment>([
      [1, { id: 1, in_reply_to_id: 2 }],
      [2, { id: 2, in_reply_to_id: 1 }],
    ]);
    expect(threadRootId(1, byId)).toBeTypeOf("number");
  });
});

describe("collectThreadComments", () => {
  it("groups only comments belonging to the same thread", () => {
    const comments = [
      { id: 1 },
      { id: 2, in_reply_to_id: 1 },
      { id: 3, in_reply_to_id: 1 },
      { id: 10 },
      { id: 11, in_reply_to_id: 10 },
    ];
    const thread = collectThreadComments(2, comments);
    expect(thread.map((c) => c.id).sort()).toEqual([1, 2, 3]);
  });
});

describe("fetchPullRequestSummary", () => {
  function fakeOctokit(overrides: {
    get?: Octokit["rest"]["pulls"]["get"];
    listFiles?: Octokit["rest"]["pulls"]["listFiles"];
  }): Octokit {
    return {
      paginate: () => {
        throw new Error("fetchPullRequestSummary should not paginate");
      },
      rest: {
        pulls: {
          listReviewComments: () => {
            throw new Error("not expected to be called");
          },
          createReplyForReviewComment: () => {
            throw new Error("not expected to be called");
          },
          get: overrides.get ?? (async () => ({ data: { title: "", body: null } })),
          listFiles: overrides.listFiles ?? (async () => ({ data: [] })),
        },
        issues: {
          listComments: () => {
            throw new Error("not expected to be called");
          },
          listForRepo: () => {
            throw new Error("not expected to be called");
          },
          getLabel: () => {
            throw new Error("not expected to be called");
          },
          createLabel: () => {
            throw new Error("not expected to be called");
          },
          create: () => {
            throw new Error("not expected to be called");
          },
          createComment: () => {
            throw new Error("not expected to be called");
          },
        },
        repos: {
          listTags: () => {
            throw new Error("not expected to be called");
          },
        },
        reactions: {
          createForIssueComment: () => {
            throw new Error("not expected to be called");
          },
          createForPullRequestReviewComment: () => {
            throw new Error("not expected to be called");
          },
        },
      },
    };
  }

  it("combines the PR's title, description, and changed files", async () => {
    const octokit = fakeOctokit({
      get: async () => ({ data: { title: "Add territory extraction", body: "Implements the ascii renderer." } }),
      listFiles: async () => ({ data: [{ filename: "src/ascii/territory.ts" }, { filename: "src/index.ts" }] }),
    });

    const summary = await fetchPullRequestSummary(octokit, "owner", "repo", 7);

    expect(summary).toEqual({
      title: "Add territory extraction",
      body: "Implements the ascii renderer.",
      changedFiles: ["src/ascii/territory.ts", "src/index.ts"],
    });
  });

  it("passes through a null PR description rather than inventing one", async () => {
    const octokit = fakeOctokit({ get: async () => ({ data: { title: "No description PR", body: null } }) });

    const summary = await fetchPullRequestSummary(octokit, "owner", "repo", 7);

    expect(summary.body).toBeNull();
  });
});
