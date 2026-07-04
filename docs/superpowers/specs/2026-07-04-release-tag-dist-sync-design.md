# Release Tag / Dist Sync Fix

## Problem

`.github/workflows/release.yml` runs on `push: tags: v*`. It builds the minified
`dist/index.js` bundle and commits it to `main` — but the commit that carries the fresh
build lands *after* the tag already exists, and only the moving major tag (e.g. `v1`) gets
force-updated to point at that new commit. The specific version tag (e.g. `v1.4.0`) is never
moved, so it permanently points at the pre-build commit — the one where `dist/index.js` still
reflects whatever code was last built, not the code this release actually adds.

Confirmed in production on 2026-07-04: a workflow pinned to `packagerating/audit-dependencies@v1.4.0`
(the exact tag for this release's Yarn Berry lockfile support) ran against a `dist/index.js` with
zero references to the new Yarn Berry parser — a completely different bundle than the one at `@v1`,
which correctly force-moved to the post-build commit. The feature code itself was independently
verified correct (`resolveLockfileVersions`/`discoverPackages` resolve real Yarn Berry lockfiles
correctly when run directly against the source); the gap is entirely in which commit each tag
points to.

This affects every release tag ever cut by this workflow (`v1.0.0` through `v1.4.0`) — anyone
pinning an exact version tag has always silently gotten a build one commit behind what that
version claims to contain. Only `@v1`-style major-tag consumers get the correct, up-to-date code.

## Design

Insert one new step in `release.yml`, between the existing "Commit dist" step and "Create GitHub
Release" step, that force-moves the specific version tag (`${{ github.ref_name }}`) to the
just-created dist-build commit — the same two-command pattern (`git tag -f` + `git push --force`)
already used later in the workflow for the major tag, applied to the specific tag instead:

```yaml
      - name: Move version tag to the dist-build commit
        run: |
          git tag -f "${{ github.ref_name }}"
          git push origin "${{ github.ref_name }}" --force
```

Placed *before* `gh release create` so the GitHub Release is created pointing at the correct,
final commit from the moment it's created, rather than relying on the release's target
automatically following a tag moved after the fact.

No other step changes. The existing "Commit dist" step (build + conditional commit + push to
`main`) and "Update major version tag" step (unchanged, still runs after `gh release create`)
stay exactly as they are.

## Out of Scope

- **Retroactively fixing `v1.0.0` through `v1.4.0`.** Those tags stay pointing at their
  respective pre-build commits. Only releases cut after this fix ships get the corrected
  behavior.
- **Restructuring the CI model** (e.g. rebuilding `dist/` on every merge to `main` instead of
  only at release time). Considered during brainstorming as a more structurally robust
  alternative, but rejected in favor of this smaller, targeted fix — it directly closes the
  gap without changing how or when the rest of the workflow builds and commits.

## Testing

This is a workflow-only change with no unit-testable logic — verification happens by cutting the
next real release and confirming, directly against the pushed tag:

- `git rev-list -n 1 vX.Y.Z` and `git rev-list -n 1 v1` resolve to the **same** commit (today they
  differ by one commit — the dist-build commit).
- That commit's `dist/index.js` contains the release's actual new code (spot-check for a
  feature-specific string, the same technique used to root-cause this bug — e.g.
  `git show vX.Y.Z:dist/index.js | grep -c "<feature-marker>"` returns a non-zero count).
- Re-run the exact production test that surfaced this bug (the Yarn Berry test repo,
  `msoffredi/audit-dependencies-yarn-berry-test`, pinned to the newly-cut tag instead of `@v1.4.0`)
  and confirm all three packages resolve to their real lockfile-pinned versions, not silently
  falling back to cached "latest" scores.

## Files Touched

| File | Change |
|---|---|
| `.github/workflows/release.yml` | Add the "Move version tag to the dist-build commit" step |
