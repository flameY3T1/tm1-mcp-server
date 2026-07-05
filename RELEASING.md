# Releasing

Trunk-based flow: work lands on `main` continuously; a release is a separate,
deliberate "cut" step. **Merging work and cutting a release are decoupled.**
Do not pick a version, bump `package.json`, or create a tag until you actually
publish — the version (patch/minor/major) is decided at release time from the
accumulated `[Unreleased]` changes.

## During development

- Small feature branch → `npm run verify` green → fast-forward merge to `main`.
- Every user-visible change adds a bullet under `## [Unreleased]` in
  `CHANGELOG.md` (Keep a Changelog: `### Added` / `### Changed` / `### Fixed` /
  `### ⚠️ Behavior change` / `### Security`). Internal-only tooling changes may
  be omitted.
- `main` stays releasable at all times. Unpushed/unreleased commits on `main`
  are normal — they are not a release until you cut one.
- **Never** create the version tag or bump `package.json` mid-stream. That is
  what forces `git tag -f` later.

## Cutting a release

1. **Decide the version** from what sits under `[Unreleased]` (semver):
   - `patch` — fixes only, no new tools/behavior.
   - `minor` — new tool or capability, backward-compatible.
   - `major` — breaking change to a tool's contract.
2. **Finalize the changelog:** rename `## [Unreleased]` → `## [X.Y.Z] - YYYY-MM-DD`,
   add a fresh empty `## [Unreleased]` above it, and update the compare links at
   the bottom (`[Unreleased]: …/compare/vX.Y.Z...HEAD` and a new
   `[X.Y.Z]: …/compare/vPREV...vX.Y.Z`). Commit.
3. **Bump + tag atomically:** `npm version <patch|minor|major>` — this bumps
   `package.json`, commits, and creates the `vX.Y.Z` tag in one step (no manual
   tagging, no `git tag -f`).
4. **Refresh the tool README** if tools changed: `npm run tools:update-readme`.
5. **Push:** `git push --follow-tags origin main`.
6. **Publish to npm:** `npm publish` — `prepublishOnly` runs `verify`, then
   `prepack` does a clean `rm -rf dist && build`, so the tarball can never carry
   stale cruft. Sanity-check first with `npm pack --dry-run` (watch total files /
   size; no `dist.bak`, `.env`, `.mcp.json`, tests, or maps).
7. **GitHub release:** create a release for the `vX.Y.Z` tag with the changelog
   section as the body (title style: `vX.Y.Z — <short theme>`).

## Guardrails already wired

- `prepack` (`rm -rf dist && npm run build`) — clean tarball, no stale `dist/`
  cruft. Runs on `npm pack` and `npm publish`.
- `prepublishOnly` (`npm run verify`) — publish aborts if the full gate
  (typecheck + lints + tests) is not green.
- `files: ["dist", "!dist/**/*.map"]` — only compiled output ships; source,
  tests, and secrets never do.

## When a release branch IS worth it

Not for this repo's normal single-track, solo flow. Use a dedicated
`release/X.Y.Z` branch only when main must keep moving while a release is
stabilized in parallel (multiple contributors, or a long QA/staging cycle).
Otherwise a long-lived release branch just drifts from `main` for no gain.
