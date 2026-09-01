# issue-bot

A GitHub Action that files a standalone issue from a pull request comment.
Mention `@issue-bot` anywhere in a PR comment (a review comment on a
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

The bot reacts to the triggering comment with 👀 as soon as it recognizes a
valid request, then replies with a link to the filed issue once it's
created (no reply is posted if an existing open issue already covers that
comment).

Only commenters with write access to the repo — GitHub's `OWNER`, `MEMBER`,
or `COLLABORATOR` [author associations](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment)
— can trigger issue filing. A mention from anyone else (including past
contributors without ongoing write access) is ignored.

Comments from bot accounts (`user.type === "Bot"`, e.g. CI review bots) never
trigger issue filing, regardless of their author association. A bot narrating
or quoting the mention string in prose — for example, a review bot explaining
that a workflow doesn't override the `mention` input — is a well-formed,
boundary-matched mention indistinguishable from a real invocation by text
alone, so it's excluded by author type instead.

## Usage

Add a workflow like this to any repo you want it active on:

```yaml
name: issue-bot

on:
  pull_request_review_comment:
    types: [created, edited]
  issue_comment:
    types: [created, edited]

jobs:
  issue-bot:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      pull-requests: write
    steps:
      - uses: dfadler/issue-bot@v1 # pin to a commit SHA instead — see note below
```

The action itself checks whether the comment contains the mention (and, for
`issue_comment`, whether it's actually on a PR rather than a plain issue) —
you don't need an `if:` gate in the workflow.

Both events also trigger on `edited`, so posting a comment and *then* editing
it to add the mention still files an issue — not just mentioning it at
creation time. This is safe to re-run: dedup is keyed by the triggering
comment/thread-root's backlink URL, not by which event fired, so an edit
that doesn't change the mention (or a second edit of an already-filed
comment) just no-ops against the existing issue instead of filing a
duplicate.

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

| Input          | Default                | Description                                                                       |
| -------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| `mention`      | `@issue-bot`            | The mention string that triggers issue creation.                                  |
| `label`        | `from-pr-comment`       | Label applied to filed issues (auto-created if it doesn't exist). Empty to skip.   |
| `github-token` | `${{ github.token }}`  | Token used to read comments and create issues/labels.                             |

#### Using a GitHub App token

By default `github-token` falls back to the workflow's `github.token`
(the repo-scoped `GITHUB_TOKEN`). To have issues/comments authored by a
GitHub App identity instead — a distinct bot user, and org-level
install/permission management — mint an installation token with
[`actions/create-github-app-token`](https://github.com/actions/create-github-app-token)
and pass it as `github-token`:

```yaml
- uses: actions/create-github-app-token@v1
  id: app-token
  with:
    app-id: ${{ vars.APP_ID }}
    private-key: ${{ secrets.APP_PRIVATE_KEY }}

- uses: dfadler/issue-bot@<commit-sha> # v1
  with:
    github-token: ${{ steps.app-token.outputs.token }}
```

The App installation needs the same permissions the default token needs:
`issues: write` (create issues/labels) and `pull-requests: read` (read
review comments and thread context).

This only changes which token authenticates the API calls the action
already makes — it does not turn issue-bot into a standalone GitHub App
or add a webhook receiver (see
[#28](https://github.com/dfadler/issue-bot/issues/28) for why that's a
separate, larger decision).

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
