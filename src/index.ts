import * as core from "@actions/core";
import * as github from "@actions/github";
import { fileIssueFromComment, type FileIssueResult, type TriggerComment } from "./followUpIssue.js";
import { hasMention } from "./mention.js";
import type { Octokit } from "./octokit.js";
import { isIssueCommentEventPayload, isPullRequestReviewCommentEventPayload } from "./payloads.js";
import { fetchRecentIssueComments, fetchReviewThreadContext } from "./threadContext.js";

/**
 * The slice of `@actions/github`'s `Context` this action's event dispatch
 * actually reads. Narrower than the real `Context` class (which also
 * carries `sha`, `ref`, `workflow`, `runId`, etc.) so a test can hand
 * `handleEvent` a plain synthetic object - no need to fabricate two dozen
 * unrelated fields, and no type assertion needed either since `Context` is
 * structurally a subtype of this.
 */
export type EventContext = {
  eventName: string;
  payload: unknown;
  repo: { owner: string; repo: string };
};

export type HandleEventOptions = {
  mention: string;
  label: string;
};

function reportResult(result: FileIssueResult): void {
  if (result.filed) {
    core.info(`Filed issue #${result.issueNumber}: ${result.issueUrl}`);
    core.setOutput("filed", "true");
    core.setOutput("issue-number", result.issueNumber.toString());
    core.setOutput("issue-url", result.issueUrl);
    return;
  }
  core.info(`Did not file an issue: ${result.reason}`);
  core.setOutput("filed", "false");
  if (result.existingIssue) {
    core.setOutput("issue-url", result.existingIssue.url);
  }
}

/**
 * The event-dispatch core: branches on the webhook event type, validates
 * the payload shape, checks for the trigger mention, gathers thread
 * context, and files (or dedups against) a follow-up issue. Pulled out of
 * `run()` so it's directly testable with a fake `Octokit` and a synthetic
 * `context` - without needing to touch `@actions/core`/`@actions/github`'s
 * env-dependent globals.
 *
 * Returns `null` for every skip path (no mention, not a PR, unrecognized
 * payload shape, unsupported event) and the `FileIssueResult` otherwise.
 */
export async function handleEvent(
  octokit: Octokit,
  context: EventContext,
  options: HandleEventOptions,
): Promise<FileIssueResult | null> {
  const { mention, label } = options;
  const repoFullName = `${context.repo.owner}/${context.repo.repo}`;

  if (context.eventName === "pull_request_review_comment") {
    if (!isPullRequestReviewCommentEventPayload(context.payload)) {
      core.info("Unrecognized pull_request_review_comment payload shape; skipping.");
      return null;
    }
    const { comment, pull_request: pullRequest } = context.payload;
    if (!hasMention(comment.body, mention)) {
      core.info("No mention found; skipping.");
      return null;
    }
    const { rootId, conversation } = await fetchReviewThreadContext(
      octokit,
      context.repo.owner,
      context.repo.repo,
      pullRequest.number,
      comment.id,
    );
    const trigger: TriggerComment = {
      id: rootId,
      kind: "review",
      author: comment.user?.login ?? "unknown",
      body: comment.body,
      htmlUrl: comment.html_url,
      createdAt: comment.created_at,
      path: comment.path,
      diffHunk: comment.diff_hunk,
    };
    return fileIssueFromComment({
      octokit,
      repoFullName,
      prNumber: pullRequest.number,
      comment: trigger,
      conversation,
      mention,
      label,
    });
  }

  if (context.eventName === "issue_comment") {
    if (!isIssueCommentEventPayload(context.payload)) {
      core.info("Unrecognized issue_comment payload shape; skipping.");
      return null;
    }
    const { comment, issue } = context.payload;
    if (issue.pull_request === undefined) {
      core.info("Comment is not on a pull request; skipping.");
      return null;
    }
    if (!hasMention(comment.body, mention)) {
      core.info("No mention found; skipping.");
      return null;
    }
    const conversation = await fetchRecentIssueComments(
      octokit,
      context.repo.owner,
      context.repo.repo,
      issue.number,
      comment.id,
    );
    const trigger: TriggerComment = {
      id: comment.id,
      kind: "issue",
      author: comment.user?.login ?? "unknown",
      body: comment.body,
      htmlUrl: comment.html_url,
      createdAt: comment.created_at,
    };
    return fileIssueFromComment({
      octokit,
      repoFullName,
      prNumber: issue.number,
      comment: trigger,
      conversation,
      mention,
      label,
    });
  }

  core.info(`Unsupported event: ${context.eventName}`);
  return null;
}

export async function run(): Promise<void> {
  const mention = core.getInput("mention") || "@issue-bot";
  const label = core.getInput("label");
  const token = core.getInput("github-token");
  if (token.length === 0) {
    core.setFailed("No github-token input provided.");
    return;
  }

  const octokit = github.getOctokit(token);
  const { context } = github;

  const result = await handleEvent(octokit, context, { mention, label });
  if (result) {
    reportResult(result);
  }
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
