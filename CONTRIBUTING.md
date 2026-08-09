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

| Step             | Command                             | Checks                                                             |
| ---------------- | ----------------------------------- | ------------------------------------------------------------------ |
| Types            | `npm run typecheck`                 | `tsc --noEmit`, strict flags on                                    |
| Types (tests)    | `npm run typecheck:tests`           | `tests/` under the same strict flags (`tsconfig.test.json`)        |
| API shape        | `npm run lint:no-flat-api`          | new TM1 calls go through a service, not flat client                |
| Annotations      | `npm run lint:annotations`          | every tool declares its MCP hint annotations                       |
| Output schemas   | `npm run lint:output-schema`        | every tool has a registered strict output schema                   |
| Schema budget    | `npm run lint:output-schema-budget` | serialized output schemas stay within the byte budget              |
| Registration     | `npm run lint:tool-registration`    | every `register*` is wired into `src/tools/index.ts`               |
| Input naming     | `npm run lint:input-naming`         | no tool takes a bare top-level `name` input (use `<entity>Name`)   |
| Envelope         | `npm run lint:mutation-envelope`    | mutation tools return via `actionResponse()`, not hand-rolled      |
| Lint             | `npm run lint:eslint`               | ESLint over the repo                                               |
| Tests + coverage | `npm run coverage:check`            | full `vitest` suite under coverage, then the coverage ratchet gate |

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
- **Coverage is a ratchet.** Floors live in `coverage-thresholds.json` and are
  enforced by `vitest` _and_ by `scripts/check-coverage-ratchet.mjs`, which also
  fails when coverage climbs well above the floor without the floor being
  raised. Never lower a floor to turn a red build green — see
  [Coverage Policy](README.md#coverage-policy).
- Live (against a real TM1) is optional but encouraged for tool changes; note in
  the PR what you validated.

### The four test classes

The suite mixes four kinds of test that prove different things. Know which one
you are writing, and say so in the PR — "I added tests" is not a claim until the
class is named.

| Class                    | Lives in                              | Asserts                                                      | Proves                                                            | Does **not** prove                                                                                           |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **behavioral/invariant** | `tests/unit/`, `tests/property/`      | our logic and its invariants, against hand-written mocks     | the code does what we intended, and keeps doing it under refactor | anything about TM1. The mock is our belief about TM1, restated                                               |
| **recorded contract**    | _none yet_ — see below                | our parsing against captured real TM1 responses              | we can read what the server actually sends                        | that we send the right request, or that the capture is still current                                         |
| **request-shape**        | `tests/unit/` (client/service suites) | the OData/HTTP request we build — URL, method, body, `$`-ops | the request is stable and does not silently change                | that TM1 accepts it. Source and mock can be changed together and stay green                                  |
| **live**                 | `tests/live/`                         | real calls against a real server                             | the round trip works on that server, that version, that day       | anything in CI — the live suite never runs by default, and its harness stubs the transport/registration edge |

Two consequences worth internalising:

- **The aggregate test count is not a confidence number.** It sums four classes
  that carry very different weight, and the largest class (behavioral) asserts
  against mocks we wrote. Cite it as suite size, never as evidence of REST
  correctness. If you quote it in a PR or release note, say which classes it
  contains.
- **The recorded-contract class is currently empty.** No sanitised TM1 responses
  are checked in, so nothing in CI verifies our belief about IBM's wire format.
  A coordinated wrong change to source _and_ mock passes every required job.
  Closing this is tracked work, not a nice-to-have.

Conventions for new tests, so the class is self-evident:

- Live tests: file named `*.live.test.ts` under `tests/live/` (already enforced
  by convention and the vitest config).
- Request-shape tests: prefix the `describe` with `request shape:` — e.g.
  `describe("request shape: DimensionService.list", ...)`. New tests only; the
  existing ~12 client suites are not retrofitted.
- Recorded-contract tests: when the first ones land, they go in
  `tests/contract/` as `*.contract.test.ts`, with the captured payloads in
  `tests/fixtures/` — sanitised, no real object or host names.
- Everything else is behavioral/invariant by default; no marker needed.

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
