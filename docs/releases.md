# Releasing Soma

A GitHub release, an Arc registry publication, and a local installation are
separate operations. State which surfaces a release request authorizes before
starting. A GitHub-only release does not update Arc or local projections.

## Prepare and verify

1. Start from current `origin/main` in a clean worktree. Compare it with the
   latest GitHub release to identify the changes actually being shipped.
2. Update `package.json`, `arc-manifest.yaml`, the README version badge and
   current-release section, and `CHANGELOG.md` together. Update the relevant
   operator guides. Do not describe an older runtime fix as new code in a
   documentation release.
3. Run `bun install --frozen-lockfile`, `bun run typecheck`,
   `bun run check-release-privacy`, and `bun test`.
4. Open the release PR, obtain review on its exact head, and verify CI before
   merging. A changed head needs a fresh review of the change.

## Publish on GitHub

Create the version tag at the verified merge commit, push that tag, and create
the GitHub release using the prepared release notes. For an already-pushed tag:

```bash
gh release create vX.Y.Z --repo the-metafactory/soma --verify-tag \
  --title "Soma X.Y.Z" --notes-file /path/to/release-notes.md
```

Read back the release and remote tag, verifying the version and target commit.
A successful PR merge alone is not proof that a release exists.

The `Publish Soma` workflow (`.github/workflows/publish-soma.yml`) is manually
dispatched. Creating a GitHub tag or release does not dispatch it. For a
GitHub-only release, leave that workflow undispatched. If Arc publication is
separately authorized, verify its result before claiming registry availability.
Local upgrades and projection refreshes also require their own verification.

## Announce the verified result

When announcements are authorized, resolve the requested Discord channels,
read their recent context, and post a concise summary with the release URL.
State GitHub-only publication explicitly when applicable. Read back the sent
messages or retain their delivery confirmations. Never announce success on a
publication surface that has not been verified.
