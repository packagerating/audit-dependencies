# Yarn Berry Lockfile Support

## Problem

The lockfile-based version resolution feature (shipped as `v1.3.0`) explicitly excluded Yarn
Berry (v2+) from scope, documented in the README as "Not supported: Yarn Berry (v2+) and PnP
mode — falls back to latest." A project on Yarn Berry gets no version resolution at all today:
every package silently falls back to unversioned scoring, the same as if no lockfile existed.

On investigation, "PnP mode" isn't actually a separate concern from "Berry's lockfile format."
PnP changes how `node_modules` gets populated (or, under PnP, doesn't) — it has no effect on the
structure of `yarn.lock` itself. Since this action only ever reads `package.json` and the
lockfile, never `node_modules`, supporting Berry's lockfile format transparently supports both
linker modes (`node-modules` and `pnp`) with no additional work.

## Design

### Format differences from Yarn Classic

Both Classic and Berry lockfiles are named `yarn.lock`, so telling them apart means reading the
file content, not just checking a filename. Berry lockfiles include a `__metadata:` block near
the top (holding the lockfile format version and a cache key) that Classic lockfiles never have —
a reliable, self-contained discriminator using only the file already being read.

Within a package block, Berry differs from Classic in two ways relevant to this parser:

- **Descriptors are protocol-prefixed.** Classic: `"lodash@^4.17.21"`. Berry: `"lodash@npm:^4.17.21"`.
  Berry also supports non-`npm:` protocols for non-registry dependencies — `workspace:` (monorepo
  cross-references), `patch:` (local patches), `file:` (local paths), etc. Since `package.json`
  ranges are always plain semver, this parser matches only `npm:`-protocol descriptors; any name
  whose range corresponds to a different protocol (or no descriptor at all) falls back to
  unversioned, the same as any other unresolvable name — no new failure mode introduced.
- **The version field is YAML-style.** Classic: `version "4.17.21"` (quoted, no colon). Berry:
  `version: 4.17.21` (unquoted, colon-separated).

Example Berry lockfile fragment:

```yaml
# yarn lockfile v1

__metadata:
  version: 8
  cacheKey: 10c0

"axios@npm:^1.0.0":
  version: 1.7.4
  resolution: "axios@npm:1.7.4"
  checksum: 10c0/abc123
  languageName: node
  linkType: hard

"lodash@npm:^4.17.15, lodash@npm:^4.17.21":
  version: 4.17.21
  resolution: "lodash@npm:4.17.21"
  checksum: 10c0/def456
  languageName: node
  linkType: hard
```

### New parser: `src/lockfiles/yarnBerry.ts`

Structurally mirrors the existing `src/lockfiles/yarn.ts` (Classic) parser — same block-detection
algorithm: a non-indented line starts a new descriptor block, an indented `version` line captures
that block's version and resets the current descriptor list. Two adjustments:

1. The version-line regex matches `version:\s*(\S+)` (unquoted, colon-separated) instead of
   Classic's `version\s+"([^"]+)"` (quoted, no colon).
2. Descriptor lookup keys are built as `` `${name}@npm:${range}` `` instead of Classic's
   `` `${name}@${range}` ``.

The `__metadata:` header block is explicitly skipped (its own header line is recognized and
ignored before the general block-parsing loop runs) so it never gets treated as a package block
— without this guard, `__metadata`'s nested `version: 8` line would otherwise be captured as if
`__metadata` were a resolved package name. Harmless in practice (no real package is named
`__metadata`), but skipped explicitly rather than left as an implicit non-issue.

Signature matches the other ecosystem parsers exactly:

```typescript
export function resolveYarnBerryVersions(
  lockfileContent: string,
  packages: NamedRange[],
): Map<string, string>
```

### Dispatcher update: `src/lockfiles/index.ts`

When `yarn.lock` exists, its content is read once (as today) and checked for a `__metadata:` line
before dispatching:

- Present → `resolveYarnBerryVersions`
- Absent → `resolveYarnVersions` (Classic, unchanged)

One file read either way — no double I/O to distinguish the formats.

### Documentation

`README.md`'s "Version resolution" section currently states:

> Not supported: Yarn Berry (v2+) and PnP mode — falls back to latest, same as no lockfile found.

This is corrected to state that Yarn Berry is supported (both linker modes, since PnP doesn't
affect the lockfile format), removing the now-inaccurate PnP caveat entirely.

## Out of Scope

- **`workspace:`/`patch:`/`file:` protocol descriptors.** Not real registry packages; ranges
  resolving to these protocols fall back to unversioned, same as any other unresolvable name.
- **npm/pnpm workspaces.** Still a separate, already-documented backlog item — unrelated to this
  change.
- **Transitive dependency version auditing.** Still root/direct dependencies only, matching the
  existing scope of every other lockfile parser in this action.

## Testing

- `resolveYarnBerryVersions`: single-descriptor block, multi-descriptor block (two ranges sharing
  one resolved version, mirroring Classic's equivalent test), a name/range with no matching
  `npm:`-protocol descriptor (omitted from the result), a `workspace:`-protocol descriptor present
  in the lockfile for a name that also has an `npm:` range requested (only the `npm:` match counts
  — the `workspace:` entry is a distinct descriptor key, never confused with it), and confirmation
  that `__metadata`'s own `version:` line never appears as a resolved entry for any requested name.
- `resolveLockfileVersions` (dispatcher): a Berry-format `yarn.lock` (with `__metadata:`) dispatches
  to the Berry parser; a Classic-format `yarn.lock` (without it) still dispatches to the existing
  Classic parser unchanged — a regression test for the format-sniffing branch.
- Regression: all existing Classic parser tests continue to pass unmodified — this change adds a
  new code path, it doesn't touch `src/lockfiles/yarn.ts`.

## Files Touched

| File | Change |
|---|---|
| `src/lockfiles/yarnBerry.ts` | New — Berry lockfile parser |
| `src/lockfiles/index.ts` | Content-sniff `yarn.lock` for `__metadata:` before dispatching |
| `README.md` | Remove the "Yarn Berry / PnP not supported" caveat |
