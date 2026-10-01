---
name: pin-action-sha
description: Pin or bump a GitHub Action in a workflow or composite action to a full commit SHA with a correct version comment (`uses: owner/repo@<sha> # v1.2.3`). Use when adding, updating, or reviewing any `uses:` line under .github/ or in action.yml, or when `npm run check:action-pins` fails.
---

# Pinning actions to a SHA

Every third-party `uses:` in this repo is pinned to a full 40-char commit SHA
with the exact release tag in a trailing comment:

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
```

The SHA is what runs. The comment is what reviewers read. If they disagree,
the comment is a lie that people trust, so CI fails on it
(`npm run check:action-pins`, job `action-pins` in `ci.yml`).

## Adding or bumping a pin

1. Pick the release tag, the full one (`v7.0.1`), not a floating major (`v7`).
2. Resolve it to a **commit** SHA, peeling annotated tags:
   ```bash
   git ls-remote https://github.com/actions/checkout 'refs/tags/v7.0.1' 'refs/tags/v7.0.1^{}'
   ```
   If a `^{}` line is printed, use that SHA (the commit); otherwise use the one line.
3. Write `@<sha> # <tag>` and change **both sides together**.
4. Run `npm run check:action-pins`.

## Rules

- Never write the comment from memory or copy it from another line. Resolve it.
- Never edit only one side of a pin.
- Never trust an existing comment as proof of what version is pinned. Verify with the check.
- Don't pin to a tag or branch (`@v4`, `@main`) in a workflow; the check rejects it.
- Local (`./path`) and `docker://` refs are exempt.

## When the check fails

| Kind | Meaning | Fix |
| --- | --- | --- |
| `mismatch` | The commented tag doesn't point at the SHA. | Decide which side is right. If the SHA is intended, `npm run check:action-pins -- --fix` rewrites the comment to the real tag. If the comment is intended, replace the SHA (step 2). |
| `missing-comment` / `bad-comment` | No `# vX.Y.Z`, or the comment doesn't start with one. | Add the tag (step 2). `--fix` does not do this. |
| `mutable-ref` | Pinned to a tag or branch. | Resolve it to a SHA (step 2). |
| `lookup-error` | `git ls-remote` failed (network, repo moved). | Retry; if the repo was renamed, update the `uses:` path. |

`--fix` only ever rewrites the comment. It never changes a SHA, because that
changes what code runs.

## Related

This repo's own pins in README.md (`dfadler/issue-bot@<sha> # v1`) are a
different mechanism: `npm run generate:sha-pins` rewrites the SHA to match the
tag, since `v1` moves on every release. See the README's Releasing section.
