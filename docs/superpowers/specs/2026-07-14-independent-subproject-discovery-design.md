# Independent Subproject Discovery

## Problem

`audit-workspaces` (shipped 2026-07-04, see
`docs/superpowers/specs/2026-07-04-monorepo-workspace-support-design.md`) discovers dependencies
across an npm/yarn/pnpm **workspace** — but only when the repo actually declares one, via a root
`"workspaces"` field or `pnpm-workspace.yaml`. A large class of real repos are monorepos in the
looser, more common sense — several independently-managed Node projects living in one git repo,
each with its own `package.json` **and its own separate lockfile**, with no workspace tooling
linking them at all.

`packagerating/package-rating` itself is a concrete example: the repo root, `admin/`, `frontend/`,
and `infrastructure/` each have their own `package.json`. None are declared as workspace members —
`admin/package.json` has no relationship to the root's `package.json` that npm/yarn/pnpm
understands. Running this action against that repo today scores only the root's dependencies;
`admin/`'s dependencies (React, Vite, Testing Library, etc.) are invisible to the audit, silently.

## Design

### Why this is cheaper than it looks

Two things from the existing workspace-support architecture carry over almost unchanged:

- **`resolveLockfileVersions(lockfileDir, packages, memberPath?)` is already directory-generic.**
  For a *workspace* member, it deliberately reads the ROOT's unified lockfile and looks up the
  member's entries inside it via `memberPath` (correct, because workspace tooling keeps one shared
  lockfile). For an independent subproject, the fix is simpler than that: call the same function
  with `lockfileDir` pointed at the *subproject's own directory* and no `memberPath` at all —
  because a standalone lockfile has no per-member structure to look anything up inside; it's just a
  normal, self-contained lockfile, exactly like the root's.
- **The report is already flat.** `discoverPackages()` returns a deduplicated `{name, version}[]`
  with no `memberPath` surviving into `score.ts`/`report.ts` — every source (root, workspace
  members) is already merged into one list before scoring. Adding a new discovery source requires
  no changes to scoring or reporting.

### Subproject detection (`src/subprojects.ts`, new)

```typescript
export function discoverSubprojects(
  rootDir: string,
  maxDepth: number,
  extraExcludeGlobs: string[],
  alreadyDiscovered: string[],
): string[]
```

Glob-scans `rootDir` for `**/package.json` via `fast-glob` (already a dependency, added for
workspace support), bounded by `maxDepth`, and returns relative paths (from `rootDir`) to each
containing directory — **excluding**:

- The root's own `package.json` (depth 0 — handled separately, exactly as today).
- `node_modules` — **mandatory, not overridable by `extraExcludeGlobs`**. Without this, the scan
  would recurse into every installed dependency's own `package.json`, making it pathologically
  expensive (and semantically wrong) on any repo with dependencies actually installed at scan time.
- A fixed default list also always applied: `.git`, `dist`, `build`, `coverage`, `vendor`.
- Any path already present in `alreadyDiscovered` (the workspace members `discoverWorkspaceMembers`
  already found) — a directory that's a *formal* workspace member must not also be independently
  rescanned here, or its dependencies would resolve twice via two different lockfile strategies.
- Any path matching `extraExcludeGlobs` (user-supplied, additive on top of the fixed list above).

Unlike `discoverWorkspaceMembers` (which trusts glob-matched directories to contain a
`package.json`, since workspace globs are author-declared and rarely wrong), this scan is *finding*
`package.json` files directly — there's no "matched a directory without one" case to skip.

### Threading subproject scope into `discover.ts`

`ScopedRange` (internal to `discover.ts`) gains a discriminator:

```typescript
interface ScopedRange {
  name: string
  range: string | undefined
  memberPath: string | undefined
  ownLockfile: boolean  // true only for independent subprojects
}
```

`ownLockfile` defaults to `false` for the root and for formal workspace members (unchanged
resolution path: shared root lockfile, looked up via `memberPath`). Independent subprojects set it
`true`.

The version-resolution loop in `discoverPackages` splits accordingly:

- Entries with `ownLockfile: false` resolve exactly as today — grouped by `memberPath`, all resolved
  against the shared `lockfileDir` (the root's directory).
- Entries with `ownLockfile: true` resolve **individually per subproject** — for each distinct
  subproject `memberPath`, call `resolveLockfileVersions(path.join(lockfileDir, memberPath), namedRanges)`
  with no `memberPath` argument, since that call is now reading a fully independent, self-contained
  lockfile.

Both groups' results feed into the same final dedup step that already exists (by `(name, version)`
pair) — no change needed there.

### New action inputs

```yaml
audit-subprojects:
  description: 'Discover and score independent package.json directories not covered by workspace protocol (npm/yarn "workspaces" or pnpm-workspace.yaml). Set to false to disable.'
  required: false
  default: 'true'

subproject-max-depth:
  description: 'Maximum directory depth (below repo root) to scan for independent package.json files'
  required: false
  default: '3'

subproject-exclude:
  description: 'Comma-separated additional glob patterns to exclude from subproject discovery (node_modules, .git, dist, build, coverage, and vendor are always excluded regardless of this input)'
  required: false
  default: ''
```

`audit-subprojects` is a separate input from `audit-workspaces`, not an extension of it —
`audit-workspaces`'s name specifically means the formal workspace protocol; conflating the two would
make the input's own description harder to write precisely and would remove the ability to enable
one discovery mode without the other. Both default to `true` — for a repo with neither workspaces
nor extra subproject directories, both are no-ops, so this doesn't change behavior for the common
single-`package.json` case at all.

## Out of Scope

- **Per-package "found in \<subproject\>" attribution in the report** — same reasoning and same
  deferral as the existing workspace-support spec: the report already doesn't attribute packages to
  their source project for workspace members either, so this isn't a new gap introduced here, just
  an existing one that now also applies to subprojects. A future enhancement if requested for both
  cases together.
- **Nested subprojects** (a discovered subproject that itself contains further nested
  `package.json` files within `subproject-max-depth`) — each depth-bounded match is treated as its
  own leaf project independently; no special handling for a subproject-within-a-subproject beyond
  what the depth bound and exclude list already provide.
- **Non-npm/yarn/pnpm package managers inside a subproject** — resolution still goes through the
  same `resolveLockfileVersions` dispatcher, so a subproject with none of the three recognized
  lockfiles present falls back to `version: null` for its packages, identical to today's existing
  no-lockfile behavior at the root.
- **Auto-detecting `subproject-max-depth` from repo size or structure** — a fixed, user-configurable
  default is sufficient; no attempt to be adaptive.

## Testing

- `src/subprojects.ts`: `discoverSubprojects` finds a real independent `package.json` at various
  depths up to `maxDepth` and correctly stops beyond it; `node_modules` is excluded even when not
  listed in `extraExcludeGlobs`; a path already in `alreadyDiscovered` is not returned a second time;
  `extraExcludeGlobs` correctly suppresses an otherwise-matching directory; the root's own
  `package.json` is never included in the result.
- `discover.ts`: a repo with one independent subproject (own `package.json` + own
  `package-lock.json`, distinct dependencies from the root) resolves that subproject's dependencies
  from *its own* lockfile, not the root's; a repo with both a formal workspace member AND an
  independent subproject resolves each via its correct strategy and doesn't double-count the
  workspace member; `audit-subprojects: false` disables subproject discovery even when independent
  subprojects exist, behaving exactly as before this feature; a subproject with no lockfile present
  falls back to `version: null` for its packages, matching root/no-lockfile behavior.
- Regression: every existing test in `tests/discover.test.ts` and `tests/workspaces.test.ts`
  continues to pass unmodified — `ownLockfile` defaults to `false` everywhere it isn't explicitly
  set true, preserving today's exact resolution path for the root and for formal workspace members.

## Files Touched

| File | Change |
|---|---|
| `src/subprojects.ts` | New — `discoverSubprojects` |
| `src/discover.ts` | `ScopedRange` gains `ownLockfile`; version-resolution loop splits shared-lockfile vs. own-lockfile groups |
| `src/index.ts` | Reads new `audit-subprojects`, `subproject-max-depth`, `subproject-exclude` inputs |
| `action.yml` | Documents the three new inputs |
| `README.md` | Documents independent-subproject discovery, distinct from the existing workspace-support section |
