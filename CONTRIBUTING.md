# Contributing

Thanks for your interest in `tm1-mcp-server`. This is a community project; PRs
and issues are welcome.

## Prerequisites

- Node.js >= 20
- Access to a TM1 / Planning Analytics instance for live testing (the unit and
  property suites run without one)

## Setup

```bash
git clone https://github.com/flameY3T1/tm1-mcp-server.git
cd tm1-mcp-server
npm install
cp .env.example .env   # fill in TM1 connection details
npm run build
```

Run locally with live reload:

```bash
npm run dev
```

## Before You Open a PR

Run the full verification gate — CI runs the same:

```bash
npm run verify
```

This chains:

| Step | Command | Checks |
|------|---------|--------|
| Types | `npm run typecheck` | `tsc --noEmit`, strict flags on |
| API shape | `npm run lint:no-flat-api` | new TM1 calls go through a service, not flat client |
| Annotations | `npm run lint:annotations` | every tool declares its MCP hint annotations |
| Tests | `npm test` | full `vitest` suite |

If your change adds, removes, or renames a tool, regenerate the README tool list:

```bash
npm run tools:update-readme
```

## Architecture Notes

- **Service composition.** TM1 REST calls live in a service under
  `src/tm1-client/services/`, not directly on a flat client. The
  `lint:no-flat-api` gate enforces this — add new calls to the appropriate
  service.
- **Tools** are registered under `src/tools/<category>/` and wired in
  `src/tools/index.ts`. Each tool declares `readOnlyHint` / `destructiveHint` /
  `idempotentHint` annotations (`src/tools/annotation-map.ts`).
- **Output schemas** are strict (`additionalProperties: false`) — when a handler
  returns a new field, add it to the matching schema in `src/tools/schemas/`, or
  the SDK rejects the payload.
- **Secrets** are masked in tool output (`src/lib/mask-secrets.ts`); never log
  raw credentials.

## Tests

- Unit tests: `tests/unit/`. Add coverage for new behaviour — prefer testing a
  pure function over an end-to-end mock where possible.
- Run a single file: `npx vitest run tests/unit/<file>.test.ts`.
- Live (against a real TM1) is optional but encouraged for tool changes; note in
  the PR what you validated.

## Commits & PRs

- Use [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`).
- Keep diffs focused; one logical change per PR.
- Describe what you changed, why, and how you verified it.
- Never commit real customer object names, server hostnames, or credentials —
  use synthetic or redacted values in tests and docs.

## Releasing

See [`RELEASING.md`](RELEASING.md). In short: work lands on `main` continuously
and each change adds a `CHANGELOG.md` entry under `[Unreleased]`; the version is
picked and tagged only at publish time via `npm version` — never bump
`package.json` or tag mid-stream.

## License

By contributing, you agree your contributions are licensed under the
[MIT License](LICENSE).
