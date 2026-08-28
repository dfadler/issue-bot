import type { Octokit } from "./octokit.js";

export type BacklinkKind = "review" | "issue";

/**
 * The exact permalink fragment GitHub itself generates for a comment -
 * used both as the back-link in a filed issue's body and as the dedup
 * marker searched for in every open issue's body. Ported from
 * claude-review-app's followUpIssue.ts (`threadUrl`), generalized to
 * cover both review comments (`#discussion_r<id>`) and general PR
 * conversation comments (`#issuecomment-<id>`).
 */
export function backlinkUrl(
  repoFullName: string,
  prNumber: number,
  kind: BacklinkKind,
  commentId: number,
): string {
  const fragment = kind === "review" ? `discussion_r${commentId}` : `issuecomment-${commentId}`;
  return `https://github.com/${repoFullName}/pull/${prNumber}#${fragment}`;
}

/**
 * Boundary-anchored so "discussion_r100" doesn't false-positive against an
 * unrelated issue's "discussion_r1004" (100 is a substring of 1004) - same
 * reasoning as claude-review-app's dedupMarkerPattern.
 */
function dedupMarkerPattern(kind: BacklinkKind, commentId: number): RegExp {
  const prefix = kind === "review" ? "discussion_r" : "issuecomment-";
  return new RegExp(`${prefix}${commentId}([^0-9]|$)`);
}

export type OpenIssueSummary = { number: number; url: string; body: string | null };

/**
 * Returns the existing open issue that already covers this exact comment,
 * if any - matched locally against every open issue's actual body (not via
 * `search`, which is documented as not guaranteeing exact substring
 * matches), same approach as claude-review-app.
 */
export function findExistingIssue(
  openIssues: OpenIssueSummary[],
  repoFullName: string,
  prNumber: number,
  kind: BacklinkKind,
  commentId: number,
): OpenIssueSummary | null {
  const pattern = dedupMarkerPattern(kind, commentId);
  const expectedUrl = backlinkUrl(repoFullName, prNumber, kind, commentId);
  return (
    openIssues.find((issue) => issue.body?.includes(expectedUrl) && pattern.test(issue.body)) ?? null
  );
}

export type TriggerComment = {
  id: number;
  kind: BacklinkKind;
  author: string;
  body: string;
  htmlUrl: string;
  createdAt: string;
  path?: string;
  diffHunk?: string;
};

export type ConversationEntry = {
  author: string;
  body: string;
  createdAt: string;
};

/**
 * Title is derived deterministically from the comment text - no LLM call
 * in this action, the trigger is the literal mention, not a model's
 * judgment.
 */
export function buildIssueTitle(commentBody: string, mention: string): string {
  const firstLine = commentBody.split("\n").find((line) => line.trim().length > 0) ?? "";
  const mentionPattern = new RegExp(mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const withoutMention = firstLine.replace(mentionPattern, "").trim();
  const title = withoutMention.length > 0 ? withoutMention : "Follow-up from PR comment";
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

export function buildIssueBody(params: {
  comment: TriggerComment;
  repoFullName: string;
  prNumber: number;
  conversation: ConversationEntry[];
}): string {
  const { comment, repoFullName, prNumber, conversation } = params;
  const sections: string[] = [];

  sections.push(
    `> ${comment.body.split("\n").join("\n> ")}`,
    "",
    `— **${comment.author}** in [this comment](${comment.htmlUrl})`,
  );

  if (comment.path !== undefined && comment.diffHunk !== undefined) {
    sections.push("", `### Related code (\`${comment.path}\`)`, "```diff", comment.diffHunk, "```");
  }

  if (conversation.length > 0) {
    sections.push(
      "",
      "### Conversation",
      ...conversation.map((entry) => `- **${entry.author}**: ${entry.body.split("\n")[0]}`),
    );
  }

  sections.push("", "---", `Filed from ${backlinkUrl(repoFullName, prNumber, comment.kind, comment.id)}.`);

  return sections.join("\n");
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}

/**
 * Unlike claude-review-app's followUpIssue.ts (which *fails* when an
 * AI-chosen label doesn't already exist, because there it validates
 * against a fixed taxonomy), this action manages a single label of its
 * own - auto-creating it is friendlier than failing.
 */
export async function ensureLabelExists(
  octokit: Octokit,
  owner: string,
  repo: string,
  label: string,
): Promise<void> {
  try {
    await octokit.rest.issues.getLabel({ owner, repo, name: label });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
    await octokit.rest.issues.createLabel({ owner, repo, name: label, color: "ededed" });
  }
}

export type FileIssueParams = {
  octokit: Octokit;
  repoFullName: string;
  prNumber: number;
  comment: TriggerComment;
  conversation: ConversationEntry[];
  mention: string;
  label: string;
};

export type FileIssueResult =
  | { filed: true; issueNumber: number; issueUrl: string }
  | { filed: false; reason: string; existingIssue?: OpenIssueSummary };

/**
 * Dedups against open issues, ensures the label exists, and files a new
 * issue if nothing already covers this comment. Ported from
 * claude-review-app's fileFollowUpIssue, minus the AI-proposal validation
 * step (title/body are derived from the comment directly here).
 */
export async function fileIssueFromComment(params: FileIssueParams): Promise<FileIssueResult> {
  const [owner, repo] = params.repoFullName.split("/");
  if (owner === undefined || repo === undefined) {
    return { filed: false, reason: `Malformed repoFullName: ${params.repoFullName}` };
  }

  const { data: openIssues } = await params.octokit.rest.issues.listForRepo({
    owner,
    repo,
    state: "open",
    per_page: 100,
  });
  const existing = findExistingIssue(
    openIssues.map((issue) => ({ number: issue.number, url: issue.html_url, body: issue.body ?? null })),
    params.repoFullName,
    params.prNumber,
    params.comment.kind,
    params.comment.id,
  );
  if (existing) {
    return { filed: false, reason: "An open issue already covers this comment", existingIssue: existing };
  }

  if (params.label.length > 0) {
    await ensureLabelExists(params.octokit, owner, repo, params.label);
  }

  const { data: created } = await params.octokit.rest.issues.create({
    owner,
    repo,
    title: buildIssueTitle(params.comment.body, params.mention),
    body: buildIssueBody({
      comment: params.comment,
      repoFullName: params.repoFullName,
      prNumber: params.prNumber,
      conversation: params.conversation,
    }),
    labels: params.label.length > 0 ? [params.label] : undefined,
  });

  return { filed: true, issueNumber: created.number, issueUrl: created.html_url };
}
