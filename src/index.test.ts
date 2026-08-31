import { describe, expect, it, vi } from "vitest";
import { handleEvent, type EventContext } from "./index.js";
import type { CreatedIssueApi, Octokit } from "./octokit.js";
import type { IssueCommentPayload, ReviewCommentPayload } from "./payloads.js";

const MENTION = "@issue-bot";

function notImplemented(name: string): () => never {
  return () => {
    throw new Error(`unexpected call: ${name}`);
  };
}

/**
 * A fully-populated fake satisfying the minimal `Octokit` interface (every
 * method typed by `Octokit` must be present), with every method defaulting
 * to a stub that throws if called. Each test overrides only the methods its
 * scenario actually exercises, per the guidance in issue #3 to stub just
 * what's called along the path under test.
 */
function createFakeOctokit(overrides: {
  listReviewComments?: Octokit["rest"]["pulls"]["listReviewComments"];
  listComments?: Octokit["rest"]["issues"]["listComments"];
  listForRepo?: Octokit["rest"]["issues"]["listForRepo"];
  getLabel?: Octokit["rest"]["issues"]["getLabel"];
  createLabel?: Octokit["rest"]["issues"]["createLabel"];
  create?: Octokit["rest"]["issues"]["create"];
}): Octokit {
  return {
    paginate: async (route, params) => {
      const { data } = await route(params);
      return data;
    },
    rest: {
      pulls: {
        listReviewComments: overrides.listReviewComments ?? notImplemented("pulls.listReviewComments"),
      },
      issues: {
        listComments: overrides.listComments ?? notImplemented("issues.listComments"),
        listForRepo: overrides.listForRepo ?? (async () => ({ data: [] })),
        getLabel: overrides.getLabel ?? notImplemented("issues.getLabel"),
        createLabel: overrides.createLabel ?? notImplemented("issues.createLabel"),
        create: overrides.create ?? notImplemented("issues.create"),
      },
    },
  };
}

/**
 * Builds a review comment carrying every field the real GitHub API and
 * webhook payload both include - used both as an item in the
 * `listReviewComments` thread response and as the triggering payload's
 * `comment` (which must satisfy payloads.ts's stricter
 * `ReviewCommentPayload` type guard, including `html_url`/`path`/`diff_hunk`).
 */
function reviewComment(overrides: Partial<ReviewCommentPayload> & { in_reply_to_id?: number }): ReviewCommentPayload & {
  in_reply_to_id?: number;
} {
  return {
    id: 1,
    body: `${MENTION} please look at this`,
    html_url: "https://github.com/owner/repo/pull/7#discussion_r1",
    created_at: "2026-01-01T00:00:00Z",
    path: "src/foo.ts",
    diff_hunk: "@@ -1,2 +1,2 @@\n-old\n+new",
    user: { login: "octocat" },
    author_association: "OWNER",
    ...overrides,
  };
}

/**
 * Builds an issue/PR-conversation comment carrying every field the real
 * GitHub API and webhook payload both include - used both as an item in the
 * `listComments` conversation response and as the triggering payload's
 * `comment` (which must satisfy payloads.ts's `IssueCommentPayload` type
 * guard, including `html_url`).
 */
function issueComment(overrides: Partial<IssueCommentPayload>): IssueCommentPayload {
  return {
    id: 1,
    body: `${MENTION} please look at this`,
    html_url: "https://github.com/owner/repo/pull/3#issuecomment-1",
    created_at: "2026-01-01T00:00:00Z",
    user: { login: "octocat" },
    author_association: "OWNER",
    ...overrides,
  };
}

function createdIssue(overrides: Partial<CreatedIssueApi> = {}): CreatedIssueApi {
  return { number: 99, html_url: "https://github.com/owner/repo/issues/99", ...overrides };
}

const baseContext = { repo: { owner: "owner", repo: "repo" } };
const OPTIONS = { mention: MENTION, label: "" };

describe("handleEvent - pull_request_review_comment", () => {
  it("dedups by the thread root comment id, not the triggering reply's id (regression for 218b347)", async () => {
    // The trigger is comment 202, a reply nested two levels under root
    // comment 200 (200 <- 201 <- 202). Before 218b347 the bot keyed the
    // dedup/backlink identity off the triggering comment's own id (202)
    // instead of walking to the thread root, so re-mentioning the bot
    // anywhere in an existing thread filed a brand-new issue every time
    // instead of deduping against the one already covering that thread.
    const root = reviewComment({ id: 200, body: "original comment, no mention here" });
    const middle = reviewComment({ id: 201, in_reply_to_id: 200, body: "a reply, no mention" });
    const trigger = reviewComment({ id: 202, in_reply_to_id: 201, body: `${MENTION} file this` });

    let createParams: Parameters<Octokit["rest"]["issues"]["create"]>[0] | undefined;
    const octokit = createFakeOctokit({
      listReviewComments: async () => ({ data: [root, middle, trigger] }),
      create: async (params) => {
        createParams = params;
        return { data: createdIssue() };
      },
    });

    const context: EventContext = {
      ...baseContext,
      eventName: "pull_request_review_comment",
      payload: { comment: trigger, pull_request: { number: 7 } },
    };

    const result = await handleEvent(octokit, context, OPTIONS);

    expect(result).toEqual({ filed: true, issueNumber: 99, issueUrl: createdIssue().html_url });
    // The backlink must point at the thread root (200), never the
    // triggering reply's own id (202) or the intermediate reply (201).
    expect(createParams?.body).toContain("discussion_r200");
    expect(createParams?.body).not.toContain("discussion_r202");
    expect(createParams?.body).not.toContain("discussion_r201");
  });

  it("returns null and files nothing when the mention is absent", async () => {
    const comment = reviewComment({ id: 1, body: "just a regular comment" });
    const create = vi.fn();
    const octokit = createFakeOctokit({ create });

    const context: EventContext = {
      ...baseContext,
      eventName: "pull_request_review_comment",
      payload: { comment, pull_request: { number: 7 } },
    };

    const result = await handleEvent(octokit, context, OPTIONS);

    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("returns null when the payload fails the type guard", async () => {
    const octokit = createFakeOctokit({});

    const context: EventContext = {
      ...baseContext,
      eventName: "pull_request_review_comment",
      payload: { comment: { body: "missing required fields" } },
    };

    const result = await handleEvent(octokit, context, OPTIONS);

    expect(result).toBeNull();
  });

  it("returns null and files nothing when the mentioning commenter is not a collaborator", async () => {
    const comment = reviewComment({ id: 1, author_association: "NONE" });
    const create = vi.fn();
    const octokit = createFakeOctokit({ create });

    const context: EventContext = {
      ...baseContext,
      eventName: "pull_request_review_comment",
      payload: { comment, pull_request: { number: 7 } },
    };

    const result = await handleEvent(octokit, context, OPTIONS);

    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("returns null for a past contributor without write access (CONTRIBUTOR)", async () => {
    const comment = reviewComment({ id: 1, author_association: "CONTRIBUTOR" });
    const create = vi.fn();
    const octokit = createFakeOctokit({ create });

    const context: EventContext = {
      ...baseContext,
      eventName: "pull_request_review_comment",
      payload: { comment, pull_request: { number: 7 } },
    };

    const result = await handleEvent(octokit, context, OPTIONS);

    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("returns null and files nothing when the mentioning commenter is a bot account (regression for issue-bot#29)", async () => {
    const comment = reviewComment({ id: 1, author_association: "MEMBER", user: { login: "coderabbitai", type: "Bot" } });
    const create = vi.fn();
    const octokit = createFakeOctokit({ create });

    const context: EventContext = {
      ...baseContext,
      eventName: "pull_request_review_comment",
      payload: { comment, pull_request: { number: 7 } },
    };

    const result = await handleEvent(octokit, context, OPTIONS);

    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("files an issue for a COLLABORATOR", async () => {
    const comment = reviewComment({ id: 1, author_association: "COLLABORATOR" });
    const octokit = createFakeOctokit({
      listReviewComments: async () => ({ data: [comment] }),
      create: async () => ({ data: createdIssue() }),
    });

    const context: EventContext = {
      ...baseContext,
      eventName: "pull_request_review_comment",
      payload: { comment, pull_request: { number: 7 } },
    };

    const result = await handleEvent(octokit, context, OPTIONS);

    expect(result).toEqual({ filed: true, issueNumber: 99, issueUrl: createdIssue().html_url });
  });
});

describe("handleEvent - issue_comment", () => {
  it("returns null without calling anything issue-creation related when the comment is on a plain issue", async () => {
    const comment = issueComment({ id: 5 });
    const create = vi.fn();
    const listComments = vi.fn();
    const octokit = createFakeOctokit({ create, listComments });

    const context: EventContext = {
      ...baseContext,
      eventName: "issue_comment",
      payload: { comment, issue: { number: 3 } },
    };

    const result = await handleEvent(octokit, context, OPTIONS);

    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(listComments).not.toHaveBeenCalled();
  });

  it("files an issue for a mentioned comment on a pull request's conversation tab", async () => {
    const comment = issueComment({ id: 5, body: `${MENTION} file this` });
    const octokit = createFakeOctokit({
      listComments: async () => ({ data: [] }),
      create: async () => ({ data: createdIssue({ number: 12 }) }),
    });

    const context: EventContext = {
      ...baseContext,
      eventName: "issue_comment",
      payload: { comment, issue: { number: 3, pull_request: {} } },
    };

    const result = await handleEvent(octokit, context, OPTIONS);

    expect(result).toEqual({ filed: true, issueNumber: 12, issueUrl: createdIssue({ number: 12 }).html_url });
  });

  it("returns null when the payload fails the type guard", async () => {
    const octokit = createFakeOctokit({});

    const context: EventContext = {
      ...baseContext,
      eventName: "issue_comment",
      payload: { issue: { number: 3 } },
    };

    const result = await handleEvent(octokit, context, OPTIONS);

    expect(result).toBeNull();
  });

  it("returns null and files nothing when the mentioning commenter is not a collaborator", async () => {
    const comment = issueComment({ id: 5, body: `${MENTION} file this`, author_association: "NONE" });
    const create = vi.fn();
    const octokit = createFakeOctokit({ create });

    const context: EventContext = {
      ...baseContext,
      eventName: "issue_comment",
      payload: { comment, issue: { number: 3, pull_request: {} } },
    };

    const result = await handleEvent(octokit, context, OPTIONS);

    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("returns null and files nothing when the mentioning commenter is a bot account (regression for issue-bot#29)", async () => {
    // Reproduces dfadler/issue-bot#29: a bot review comment (e.g. CodeRabbit)
    // that merely quotes the mention string in prose should not file an
    // issue, even though the text is a well-formed, boundary-matched mention
    // and even if the bot happens to carry write-level author_association.
    const comment = issueComment({
      id: 5,
      body: `the workflow doesn't override the \`mention\` input, e.g. ${MENTION}`,
      author_association: "MEMBER",
      user: { login: "coderabbitai", type: "Bot" },
    });
    const create = vi.fn();
    const octokit = createFakeOctokit({ create });

    const context: EventContext = {
      ...baseContext,
      eventName: "issue_comment",
      payload: { comment, issue: { number: 3, pull_request: {} } },
    };

    const result = await handleEvent(octokit, context, OPTIONS);

    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("handleEvent - unsupported events", () => {
  it("returns null for an event this action doesn't handle", async () => {
    const octokit = createFakeOctokit({});

    const context: EventContext = {
      ...baseContext,
      eventName: "push",
      payload: {},
    };

    const result = await handleEvent(octokit, context, OPTIONS);

    expect(result).toBeNull();
  });
});
