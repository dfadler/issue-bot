# issue-bot

A GitHub Action that files a standalone issue from a pull request comment.
Mention `@dfadler-issue-bot` anywhere in a PR comment (a review comment on a
diff line, or a general PR conversation comment) and it files an issue
capturing:

- The triggering comment itself (author, body, permalink).
- The related code, for review comments — the file path and diff hunk the
  comment is anchored to.
- The larger conversation — every reply in that review thread, or the last
  10 general PR comments for a conversation comment.
- A backlink to the source comment, used to avoid filing a duplicate issue
  if the thread gets more replies later.

No AI involved — the trigger is the literal mention, and the issue title is
derived deterministically from the comment's first line.

## Usage

Add a workflow like this to any repo you want it active on:

```yaml
name: issue-bot

on:
  pull_request_review_comment:
    types: [created]
  issue_comment:
    types: [created]

jobs:
  issue-bot:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      pull-requests: read
    steps:
      - uses: dfadler/issue-bot@v1 # pin to a commit SHA instead — see note below
```

The action itself checks whether the comment contains the mention (and, for
`issue_comment`, whether it's actually on a PR rather than a plain issue) —
you don't need an `if:` gate in the workflow.

**Pin to a commit SHA, not `@v1` or `@main`.** A tag or branch is mutable —
a security scanner (Semgrep's `github-actions-mutable-action-tag` rule, in
particular) will flag it, and it's the same reason this repo's own CI
requires every third-party action to be pinned. Use
`dfadler/issue-bot@<commit-sha> # v1` instead.

**A gotcha specific to `pull_request_review_comment`**: GitHub resolves
that event's workflow definition from a snapshot tied to the pull request
itself, not live off the default branch — unlike `issue_comment`, which
always uses the default branch's current content. If you re-pin this
action to a new commit, PRs opened *before* that change won't see it until
their branch is updated (merge/rebase the default branch into them again).
This is easy to mistake for the action silently failing to update.

### Inputs

| Input          | Default                | Description                                                                 |
| -------------- | ----------------------- | ----------------------------------------------------------------------------- |
| `mention`      | `@dfadler-issue-bot`    | The mention string that triggers issue creation.                              |
| `label`        | `from-pr-comment`       | Label applied to filed issues (auto-created if it doesn't exist). Empty to skip. |
| `github-token` | `${{ github.token }}`  | Token used to read comments and create issues/labels.                         |

### Outputs

| Output         | Description                                                                |
| -------------- | --------------------------------------------------------------------------- |
| `filed`        | `"true"` if a new issue was filed, `"false"` otherwise.                     |
| `issue-number` | The number of the filed issue, if one was filed.                            |
| `issue-url`    | The URL of the filed issue, or the existing issue that already covers this comment. |

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build   # bundles src/ into dist/index.js — commit the result
```

`dist/` is checked into git (standard for JS actions, since consumers run
the committed bundle directly). CI fails if `dist/` is stale relative to
`src/`.
