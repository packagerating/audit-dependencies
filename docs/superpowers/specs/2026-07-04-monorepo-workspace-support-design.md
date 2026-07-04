# Monorepo Workspace Support

## Problem

This action only ever audits one `package.json` — whatever `package-json-path` points at
(default `package.json` at the repo root). In a monorepo, that means only the root project's
direct dependencies ever get scored; every workspace member's own dependencies are invisible to
the audit, even though the shared lockfile at the repo root already resolves all of them.

Compounding this, `discover.ts` currently derives the lockfile directory as
`path.dirname(package-json-path)` — so even pointing `package-json-path` at a workspace member
directly (e.g. `packages/foo/package.json`) would look for a lockfile *inside that subfolder*,
not at the monorepo root where the real shared lockfile actually lives. There is no path to
correctly auditing a non-root workspace member today, let alone all of them at once.

## Design

### Workspace detection (`src/workspaces.ts`, new)

A monorepo is detected by checking, unconditionally, for either workspace-config file — no
`ecosystem` hint needed, since the two signals are mutually exclusive in practice (a repo uses one
package manager):

- **pnpm:** a `pnpm-workspace.yaml` file at the root, with its own `packages: string[]` field
  (parsed with `js-yaml`, already a dependency since the pnpm lockfile parser needs it). Checked
  first — if present, it takes priority over anything in `package.json`.
- **npm / Yarn (Classic or Berry):** root `package.json` has a `"workspaces"` field — either
  `string[]` (glob patterns directly) or `{ packages: string[] }` (the object form some projects
  use). Either shape yields a `string[]` of glob patterns. Checked only if `pnpm-workspace.yaml`
  is absent.

If neither is present, there are no workspaces — behavior is completely unchanged from today's
single-`package.json` flow.

```typescript
export function getWorkspaceGlobs(rootDir: string): string[] | null
```

Returns `null` when no workspace configuration is found (signals "not a monorepo"), or when a
found config's `packages`/`workspaces` field is itself empty or absent.

### Member discovery

Glob patterns are expanded against the filesystem with `fast-glob` (new dependency — nothing in
this repo does glob matching today) to find every matching directory. Each matching directory is
expected to contain its own `package.json`; directories without one are skipped rather than
erroring (a glob can match non-package directories, e.g. `packages/*` matching a `packages/README`
folder some repos keep for docs).

```typescript
export function discoverWorkspaceMembers(rootDir: string, globs: string[]): string[]
```

Returns relative paths (from `rootDir`) to each member directory that has a `package.json`. The
root itself is NOT included in this list — it's handled separately, exactly as it is today, since
the root project's own resolution scope (`memberPath` unset / root-scoped) already works correctly
without any workspace-specific logic.

### Threading workspace scope into version resolution

`resolveNpmVersions` and `resolvePnpmVersions` each gain an optional `memberPath` parameter (Yarn's
parsers — Classic and Berry — are untouched, since `yarn.lock` is a single flat descriptor
namespace with no per-workspace-member structure at all):

- **npm:** tries `packages["node_modules/<name>"]` (root-hoisted, the common case) first; if that
  entry doesn't exist, falls back to `packages["<memberPath>/node_modules/<name>"]` — handling the
  real case where npm couldn't hoist a dependency to the root because a *different* workspace
  member needed a conflicting version, so it nested this member's copy under its own
  `node_modules` instead.
- **pnpm:** uses `importers[memberPath ?? '.']` instead of the hardcoded `importers['.']` — pnpm's
  lockfile already has a per-member `importers` entry keyed by that member's relative path, exactly
  matching what member discovery already produces.

`resolveLockfileVersions` (the dispatcher) gains a matching optional `memberPath` parameter,
threaded to whichever parser it dispatches to (ignored by the yarn parsers, which don't accept it).

### `discover.ts` restructuring

When workspace mode is active (see "New action input" below) and workspace members are found:

1. Discover every member directory (`discoverWorkspaceMembers`).
2. For the root, and for each member: read *that project's own* `package.json` for its
   `dependencies`/`devDependencies`/`optionalDependencies` (respecting `include-dev` /
   `include-optional`, same as today), and resolve its versions via `resolveLockfileVersions` with
   that project's own `memberPath` (root gets `memberPath: undefined`; each workspace member gets
   its own discovered relative path).
3. Merge every project's resolved `{name, version}` pairs into one flat list, deduplicated by the
   `(name, version)` pair — two projects both resolving `lodash` to the identical version collapse
   into a single entry; two projects resolving `lodash` to genuinely *different* versions both
   survive as distinct entries (never silently dropped).

When workspace mode is inactive, or no workspace configuration is found, behavior is byte-for-byte
identical to today — only the root `package.json` is read, `memberPath` is never set.

### New action input

```yaml
audit-workspaces:
  description: 'Discover and score every workspace member (npm/yarn "workspaces" field, or pnpm-workspace.yaml). Set to false to only audit the root package.json.'
  required: false
  default: 'true'
```

Defaults to `true` (matching the "automatic when workspaces are declared" decision) — but since
workspace detection itself already gates on the root project actually declaring workspaces, this
default is a no-op for any non-monorepo project. Setting it to `false` forces legacy root-only
behavior even in a real monorepo, for anyone who wants that.

## Out of Scope

- **Per-package "used by \<member\>" attribution in the report.** The comment/summary lists the
  deduplicated union of packages across all workspace members, with no indication of which
  member(s) actually depend on each one. A future enhancement if requested, not part of this spec.
- **Nested workspaces** (a workspace member that is itself the root of another set of workspaces).
  Extremely rare in practice; member discovery treats every matched directory as a leaf project.
- **The `packages` input's scope.** The existing comma-separated explicit-package override
  continues to resolve only against the root project's lockfile scope, exactly as today — it is
  an escape hatch for auditing arbitrary names, not a workspace-discovery mechanism.

## Testing

- `src/workspaces.ts`: `getWorkspaceGlobs` for all three shapes (npm/yarn array form, npm/yarn
  object form, pnpm's `pnpm-workspace.yaml`), and `null` when no workspace config exists.
- `discoverWorkspaceMembers`: glob expansion finds real member directories, skips a matched
  directory with no `package.json`.
- `resolveNpmVersions`/`resolvePnpmVersions`: root-hoisted lookup still works with `memberPath`
  unset (regression, matching all pre-existing tests unmodified); the npm nested-fallback path
  resolves a conflicted dependency via `<memberPath>/node_modules/<name>` when the root entry is
  absent; the pnpm `importers[memberPath]` path resolves a non-root member correctly.
- `discover.ts`: workspace mode aggregates root + member dependencies into one deduplicated list;
  two members resolving the same package to the same version collapse into one entry; two members
  resolving to different versions of the same name both survive; `audit-workspaces: false` forces
  root-only behavior even when workspaces are declared; no workspace config found behaves exactly
  as today regardless of the `audit-workspaces` input's value.
- Regression: every existing test in `tests/discover.test.ts`, `tests/lockfiles/npm.test.ts`, and
  `tests/lockfiles/pnpm.test.ts` continues to pass unmodified — `memberPath` is optional everywhere
  it was added, defaulting to today's exact behavior.

## Files Touched

| File | Change |
|---|---|
| `src/workspaces.ts` | New — `getWorkspaceGlobs`, `discoverWorkspaceMembers` |
| `src/lockfiles/npm.ts` | `resolveNpmVersions` gains optional `memberPath`, nested-fallback lookup |
| `src/lockfiles/pnpm.ts` | `resolvePnpmVersions` gains optional `memberPath`, scoped `importers` lookup |
| `src/lockfiles/index.ts` | `resolveLockfileVersions` gains optional `memberPath`, threaded to npm/pnpm only |
| `src/discover.ts` | Workspace-mode aggregation across root + all discovered members |
| `src/index.ts` | Reads new `audit-workspaces` input |
| `action.yml` | Documents `audit-workspaces` input |
| `README.md` | Documents monorepo/workspace behavior |
| `package.json` | New `fast-glob` dependency |
