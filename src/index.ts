import * as core from "@actions/core";
import * as github from "@actions/github";
import { fileIssueFromComment, type FileIssueResult, type TriggerComment } from "./followUpIssue.js";
import { hasMention } from "./mention.js";
import { isIssueCommentEventPayload, isPullRequestReviewCommentEventPayload } from "./payloads.js";
import { fetchRecentIssueComments, fetchReviewThreadContext } from "./threadContext.js";

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

export async function run(): Promise<void> {
  const mention = core.getInput("mention") || "@dfadler-issue-bot";
  const label = core.getInput("label");
  const token = core.getInput("github-token");
  if (token.length === 0) {
    core.setFailed("No github-token input provided.");
    return;
  }

  const octokit = github.getOctokit(token);
  const { context } = github;
  const repoFullName = `${context.repo.owner}/${context.repo.repo}`;

  if (context.eventName === "pull_request_review_comment") {
    if (!isPullRequestReviewCommentEventPayload(context.payload)) {
      core.info("Unrecognized pull_request_review_comment payload shape; skipping.");
      return;
    }
    const { comment, pull_request: pullRequest } = context.payload;
    if (!hasMention(comment.body, mention)) {
      core.info("No mention found; skipping.");
      return;
    }
    const conversation = await fetchReviewThreadContext(
      octokit,
      context.repo.owner,
      context.repo.repo,
      pullRequest.number,
      comment.id,
    );
    const trigger: TriggerComment = {
      id: comment.id,
      kind: "review",
      author: comment.user?.login ?? "unknown",
      body: comment.body,
      htmlUrl: comment.html_url,
      createdAt: comment.created_at,
      path: comment.path,
      diffHunk: comment.diff_hunk,
    };
    const result = await fileIssueFromComment({
      octokit,
      repoFullName,
      prNumber: pullRequest.number,
      comment: trigger,
      conversation,
      mention,
      label,
    });
    reportResult(result);
    return;
  }

  if (context.eventName === "issue_comment") {
    if (!isIssueCommentEventPayload(context.payload)) {
      core.info("Unrecognized issue_comment payload shape; skipping.");
      return;
    }
    const { comment, issue } = context.payload;
    if (issue.pull_request === undefined) {
      core.info("Comment is not on a pull request; skipping.");
      return;
    }
    if (!hasMention(comment.body, mention)) {
      core.info("No mention found; skipping.");
      return;
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
    const result = await fileIssueFromComment({
      octokit,
      repoFullName,
      prNumber: issue.number,
      comment: trigger,
      conversation,
      mention,
      label,
    });
    reportResult(result);
    return;
  }

  core.info(`Unsupported event: ${context.eventName}`);
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
