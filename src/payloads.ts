/**
 * GitHub's own enum for a comment author's relationship to the repo - see
 * https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment.
 * `MANNEQUIN` covers a placeholder account from a repo import/migration.
 */
export type AuthorAssociation =
  | "COLLABORATOR"
  | "CONTRIBUTOR"
  | "FIRST_TIMER"
  | "FIRST_TIME_CONTRIBUTOR"
  | "MANNEQUIN"
  | "MEMBER"
  | "NONE"
  | "OWNER";

const AUTHOR_ASSOCIATIONS: ReadonlySet<string> = new Set([
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIMER",
  "FIRST_TIME_CONTRIBUTOR",
  "MANNEQUIN",
  "MEMBER",
  "NONE",
  "OWNER",
]);

function isAuthorAssociation(value: unknown): value is AuthorAssociation {
  return typeof value === "string" && AUTHOR_ASSOCIATIONS.has(value);
}

/**
 * `type` is GitHub's own discriminator for the account kind (`"User"`,
 * `"Bot"`, `"Organization"`, ...) - present on every real webhook payload,
 * but optional here since older fixtures/tests may omit it.
 */
export type CommentAuthor = { login: string; type?: string } | null;

export type ReviewCommentPayload = {
  id: number;
  body: string;
  html_url: string;
  created_at: string;
  path: string;
  diff_hunk: string;
  in_reply_to_id?: number;
  user: CommentAuthor;
  author_association: AuthorAssociation;
};

export type PullRequestReviewCommentEventPayload = {
  comment: ReviewCommentPayload;
  pull_request: { number: number };
};

export type IssueCommentPayload = {
  id: number;
  body: string;
  html_url: string;
  created_at: string;
  user: CommentAuthor;
  author_association: AuthorAssociation;
};

export type IssueCommentEventPayload = {
  comment: IssueCommentPayload;
  issue: { number: number; pull_request?: unknown };
};

function isUserOrNull(value: unknown): value is CommentAuthor {
  if (value === null) {
    return true;
  }
  if (typeof value !== "object" || !("login" in value) || typeof value.login !== "string") {
    return false;
  }
  return !("type" in value) || value.type === undefined || typeof value.type === "string";
}

/**
 * Bot-authored comments (e.g. CI review bots) commonly narrate or quote the
 * mention string in prose - "the workflow doesn't override @issue-bot" -
 * without intending to invoke this action. Skipping `type === "Bot"` by
 * default avoids that class of false-positive filing regardless of the
 * bot's own `author_association` (see dfadler/issue-bot#29).
 */
export function isBotAuthor(user: CommentAuthor): boolean {
  return user?.type === "Bot";
}

/**
 * Validates the shape this action actually reads out of the webhook
 * payload, at the untrusted-data boundary - rather than trusting
 * `context.payload`'s loose `WebhookPayload` typing.
 */
export function isPullRequestReviewCommentEventPayload(
  payload: unknown,
): payload is PullRequestReviewCommentEventPayload {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  if (!("comment" in payload) || !("pull_request" in payload)) {
    return false;
  }
  const { comment, pull_request: pullRequest } = payload;
  if (typeof comment !== "object" || comment === null) {
    return false;
  }
  if (typeof pullRequest !== "object" || pullRequest === null) {
    return false;
  }
  if (!("number" in pullRequest) || typeof pullRequest.number !== "number") {
    return false;
  }
  if (!("id" in comment) || typeof comment.id !== "number") {
    return false;
  }
  if (!("body" in comment) || typeof comment.body !== "string") {
    return false;
  }
  if (!("html_url" in comment) || typeof comment.html_url !== "string") {
    return false;
  }
  if (!("created_at" in comment) || typeof comment.created_at !== "string") {
    return false;
  }
  if (!("path" in comment) || typeof comment.path !== "string") {
    return false;
  }
  if (!("diff_hunk" in comment) || typeof comment.diff_hunk !== "string") {
    return false;
  }
  if (!("user" in comment) || !isUserOrNull(comment.user)) {
    return false;
  }
  if (!("author_association" in comment) || !isAuthorAssociation(comment.author_association)) {
    return false;
  }
  return true;
}

export function isIssueCommentEventPayload(payload: unknown): payload is IssueCommentEventPayload {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  if (!("comment" in payload) || !("issue" in payload)) {
    return false;
  }
  const { comment, issue } = payload;
  if (typeof comment !== "object" || comment === null) {
    return false;
  }
  if (typeof issue !== "object" || issue === null) {
    return false;
  }
  if (!("number" in issue) || typeof issue.number !== "number") {
    return false;
  }
  if (!("id" in comment) || typeof comment.id !== "number") {
    return false;
  }
  if (!("body" in comment) || typeof comment.body !== "string") {
    return false;
  }
  if (!("html_url" in comment) || typeof comment.html_url !== "string") {
    return false;
  }
  if (!("created_at" in comment) || typeof comment.created_at !== "string") {
    return false;
  }
  if (!("user" in comment) || !isUserOrNull(comment.user)) {
    return false;
  }
  if (!("author_association" in comment) || !isAuthorAssociation(comment.author_association)) {
    return false;
  }
  return true;
}
