import type { Octokit } from "./octokit.js";
import type { ConversationEntry } from "./followUpIssue.js";

export type ThreadableComment = { id: number; in_reply_to_id?: number };

/**
 * Walks a comment's `in_reply_to_id` chain up to the thread's root. GitHub
 * normally sets every reply's `in_reply_to_id` directly to the thread's
 * first comment, but the chain is walked defensively in case that ever
 * isn't true. `seen` guards against a cycle turning this into an infinite
 * loop.
 */
export function threadRootId(commentId: number, byId: Map<number, ThreadableComment>): number {
  let current = byId.get(commentId);
  const seen = new Set<number>();
  while (current?.in_reply_to_id !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.in_reply_to_id);
    if (!parent) {
      break;
    }
    current = parent;
  }
  return current?.id ?? commentId;
}

/**
 * Every review comment on the PR that belongs to the same thread as
 * `triggerCommentId` - the thread's root plus every reply chained to it.
 */
export function collectThreadComments<T extends ThreadableComment>(
  triggerCommentId: number,
  allComments: T[],
): T[] {
  const byId = new Map<number, ThreadableComment>(allComments.map((c) => [c.id, c]));
  const rootId = threadRootId(triggerCommentId, byId);
  return allComments.filter((c) => threadRootId(c.id, byId) === rootId);
}

type ReviewComment = {
  id: number;
  in_reply_to_id?: number;
  body: string;
  user: { login: string } | null;
  created_at: string;
};

export async function fetchReviewThreadContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  triggerCommentId: number,
): Promise<ConversationEntry[]> {
  const allComments: ReviewComment[] = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  const thread = collectThreadComments(triggerCommentId, allComments);
  return thread
    .filter((comment) => comment.id !== triggerCommentId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((comment) => ({
      author: comment.user?.login ?? "unknown",
      body: comment.body,
      createdAt: comment.created_at,
    }));
}

type IssueComment = {
  id: number;
  body?: string;
  user: { login: string } | null;
  created_at: string;
};

const RECENT_ISSUE_COMMENT_LIMIT = 10;

export async function fetchRecentIssueComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  triggerCommentId: number,
): Promise<ConversationEntry[]> {
  const allComments: IssueComment[] = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });
  return allComments
    .filter((comment) => comment.id !== triggerCommentId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(-RECENT_ISSUE_COMMENT_LIMIT)
    .map((comment) => ({
      author: comment.user?.login ?? "unknown",
      body: comment.body ?? "",
      createdAt: comment.created_at,
    }));
}
