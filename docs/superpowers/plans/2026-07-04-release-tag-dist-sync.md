# Release Tag / Dist Sync Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `release.yml` so a specific version tag (e.g. `v1.5.0`) always points at the same commit as the moving major tag (e.g. `v1`) — the commit that actually contains that release's built `dist/index.js`, not the commit one step before it.

**Architecture:** One new step in `release.yml`, inserted between the existing "Commit dist" step and "Create GitHub Release" step, force-moving the specific version tag to the dist-build commit — mirroring the exact `git tag -f` + `git push --force` pattern already used later in the same workflow for the major tag.

**Tech Stack:** GitHub Actions YAML. No application code, no unit tests possible — this is a CI workflow fix, verified by actually cutting a release and inspecting the resulting tags/commits/bundle.

## Global Constraints

- Do not modify the existing "Commit dist" step or the existing "Update major version tag" step — both stay exactly as they are today.
- Do not retroactively fix `v1.0.0` through `v1.4.0` — those tags stay pointing at their current (pre-build) commits, per an explicit scope decision made during brainstorming.
- The new step must run *before* `gh release create`, so the GitHub Release is created pointing at the final, correct commit from the moment it's created.

---

## Task 1: Add the version-tag-move step to `release.yml`

**Files:**
- Modify: `.github/workflows/release.yml`

**Interfaces:** none (standalone workflow file, no code interfaces)

- [ ] **Step 1: Read the current file to confirm its exact shape**

```bash
cat .github/workflows/release.yml
```

Confirm it matches this (it should, since no other work has touched this file recently):

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run build:minify
      - name: Commit dist
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add dist/index.js
          git diff --staged --quiet || git commit -m "chore: build dist for ${{ github.ref_name }}"
          git push origin HEAD:main
      - name: Create GitHub Release
        run: gh release create "${{ github.ref_name }}" --generate-notes
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - name: Update major version tag
        run: |
          MAJOR=$(echo "${{ github.ref_name }}" | grep -oE '^v[0-9]+')
          git tag -f "$MAJOR"
          git push origin "$MAJOR" --force
```

If it doesn't match exactly, stop and report the actual content rather than guessing — the diff in Step 2 assumes this exact starting point.

- [ ] **Step 2: Insert the new step**

Change:

```yaml
      - name: Commit dist
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add dist/index.js
          git diff --staged --quiet || git commit -m "chore: build dist for ${{ github.ref_name }}"
          git push origin HEAD:main
      - name: Create GitHub Release
        run: gh release create "${{ github.ref_name }}" --generate-notes
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

to:

```yaml
      - name: Commit dist
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add dist/index.js
          git diff --staged --quiet || git commit -m "chore: build dist for ${{ github.ref_name }}"
          git push origin HEAD:main
      - name: Move version tag to the dist-build commit
        run: |
          git tag -f "${{ github.ref_name }}"
          git push origin "${{ github.ref_name }}" --force
      - name: Create GitHub Release
        run: gh release create "${{ github.ref_name }}" --generate-notes
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The "Update major version tag" step at the end of the file is unchanged.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "fix: force-move the specific version tag to the dist-build commit on release"
```

---

## Task 2: Verify with a real release

**Files:** none (verification only — this is the plan's actual "test suite," since a CI workflow has no unit-testable logic)

This task assumes Task 1's commit is already on `main` (merged via whatever workflow executed Task 1 — worktree+PR under subagent-driven-development, or a direct commit under inline execution).

- [ ] **Step 1: Bump the version and cut a new release tag**

```bash
# from a clean main, after Task 1 is merged
npm version patch --no-git-tag-version   # or hand-edit package.json's "version" field
git add package.json
git commit -m "chore: bump version to <X.Y.Z>"
git push origin main
git tag v<X.Y.Z>
git push origin v<X.Y.Z>
```

Use whatever the next semver-appropriate version is at the time this runs (this plan doesn't hardcode a version number, since Task 1's merge timing determines it).

- [ ] **Step 2: Wait for the release workflow to complete**

```bash
gh run list --workflow=release.yml --limit 1 --json databaseId,status,conclusion
# poll until status is "completed"
```

Expected: `conclusion: "success"`.

- [ ] **Step 3: Confirm the specific tag and major tag now point at the same commit**

```bash
git fetch origin --tags
git rev-list -n 1 v<X.Y.Z>
git rev-list -n 1 v1
```

Expected: both commands print the **same** commit SHA. (Before this fix, they printed different SHAs — the specific tag one commit behind.)

- [ ] **Step 4: Confirm the specific tag's dist bundle actually contains current code**

```bash
git show v<X.Y.Z>:dist/index.js | grep -c "yarnBerry"
```

Expected: a non-zero count (the Yarn Berry parser code, which was missing from `v1.4.0`'s stale bundle, should now be present in the correctly-tagged bundle).

- [ ] **Step 5: Re-run the production test that surfaced this bug**

In the `msoffredi/audit-dependencies-yarn-berry-test` repo, update `.github/workflows/audit-dependencies.yml`'s `uses:` line from `packagerating/audit-dependencies@v1.4.0` to `packagerating/audit-dependencies@v<X.Y.Z>` (the newly-cut tag), push, and re-open (or re-trigger) the test PR.

Expected: the PR comment shows `axios` resolved to the version actually in that test repo's `yarn.lock` (not a stale cached "latest" score) — confirming the specific-tag pin now serves the correct, up-to-date bundle end-to-end.
