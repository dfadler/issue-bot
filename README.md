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
`dfadler/issue-bot@<commit-sha> # v1` instead — copy the SHA from the `v1`
tag (or a specific `v1.x.x` tag) rather than any commit on `main`; only
release refs (`v1`, `v1.x.x`, and the `releases/v1` branch they point at)
contain the built `dist/index.js` the action actually runs. See
[Releasing](#releasing) below.

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
| `version-check` | `fail`                 | `fail`, `warn`, or `off` — what to do when this pinned release is older than the latest `dfadler/issue-bot` release. See [Version check](#version-check). |

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

### Version check

On every run, before it looks at the triggering comment, the action compares
the release it was built as against the newest `vX.Y.Z` tag on
`dfadler/issue-bot`. If the running release is older, the default `fail`
mode fails the run with a message naming both versions and the exact line to
update to:

```
issue-bot v1.1.0 is running, but v1.2.0 is the latest release. Update the `uses:` line in your workflow to:

    uses: dfadler/issue-bot@<sha-of-v1.2.0> # v1.2.0
```

**Why fail, rather than warn?** A stale pin doesn't just miss new features —
it can silently change what the action does. The case that motivated this
([zombie-mermaid#358](https://github.com/dfadler/zombie-mermaid/issues/358),
from the discussion on
[zombie-mermaid#346](https://github.com/dfadler/zombie-mermaid/pull/346)): a
consumer pinned to a commit whose `action.yml` still defaulted `mention` to
the older `@dfadler-issue-bot` handle. Comments mentioning the current
`@issue-bot` never matched, so every run logged "No mention found" and
exited green. Nothing was wrong from the workflow's point of view; the
mention was simply never going to fire. That's also why the check runs
*before* the mention is looked for: gating it on a matched mention would
mean it never fires in exactly the case it exists for.

| `version-check` | Running release older than latest                                   | Up to date / newer | Can't compare (network, rate limit, no semver tags, dev build) |
| --------------- | -------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------- |
| `fail` (default) | `core.setFailed` with the message above; the comment is **not** processed | proceeds          | `core.warning`, proceeds                                        |
| `warn`          | `core.warning` with the same message; proceeds                       | proceeds           | `core.warning`, proceeds                                        |
| `off`           | proceeds (no API call made)                                          | proceeds           | proceeds                                                        |

Only an actual stale release fails. Anything that prevents the comparison
from happening — the tag lookup erroring, the token being unable to read
`dfadler/issue-bot`, a build with no embedded version — is a warning, so a
transient outage upstream can't break your issue filing.

To opt out or soften it:

```yaml
- uses: dfadler/issue-bot@<commit-sha> # v1
  with:
    version-check: warn # or "off"
```

**This works with SHA pins.** The version being compared is stamped into
`dist/index.js` at release time (see [Releasing](#releasing)), not parsed
out of your `uses:` ref — so a commit SHA copied from a `v1.x.y` tag knows
exactly which release it is. A SHA from before this check existed
(`v1.1.0` and earlier) has no such stamp and simply never checks; the
first release that includes it is the first one that can tell you it's
stale.

"Latest" means the highest full `vX.Y.Z` tag, across major versions: a
consumer on the `v1` line will be told to move up once a `v2.0.0` tag
exists. The moving major aliases (`v1`, `v2`) are never themselves treated
as "the latest release".

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
npm run build   # bundles src/ into dist/index.js (gitignored on main)
```

`npm run build` on its own produces a *dev build*: `scripts/build.mjs`
stamps an empty release version into the bundle, so the runtime
[version check](#version-check) warns and skips itself. To build the way
the release workflow does — with the version baked in — set
`ISSUE_BOT_VERSION`:

```bash
ISSUE_BOT_VERSION=1.2.3 npm run build
```

## Releasing

GitHub Actions runs `action.yml`'s `main: dist/index.js` directly from
whatever ref a consumer checks out — there's no install/build step, so the
built bundle has to already exist at that ref. Rather than commit it (and
its diff) to every commit on `main`, `dist/index.js` is gitignored there
and only published to dedicated release refs.

To cut a release, run the **Release** workflow from the Actions tab
(`workflow_dispatch`) with a `version` input like `1.2.3`. It builds
`dist/index.js` from the triggering ref with that version stamped into the
bundle (`ISSUE_BOT_VERSION`, read by `scripts/build.mjs`), commits it onto
(force-pushing) a `releases/v<major>` branch, and force-moves both the full
(`v1.2.3`) and major (`v1`) tags to that commit. Consumers keep using `@v1`
(moving) or a pinned SHA from one of those tags (immutable) exactly as
before — only where that build output actually lives has changed.

The stamped version is what the runtime [version check](#version-check)
compares against the newest `vX.Y.Z` tag, so two things about cutting a
release matter for it: the `version` input must be higher than every
existing full tag (a `1.1.5` cut after `1.2.0` would be reported as stale
the moment anyone ran it), and the workflow refuses to publish a bundle
that doesn't contain the version it's about to tag. The check reads tags, not GitHub Releases, so creating a
Release object is optional.
