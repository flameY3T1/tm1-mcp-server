# Contract fixtures

Most of the unit suite fakes TM1. Until these fixtures existed, nothing checked
those fakes against a real server: a fake could carry a field TM1 never sends,
give a field the wrong type, or model an error envelope in a shape no TM1
version produces, and the suite stayed green while production read `undefined`.
The two defects that shipped and were caught only by live measurement were both
of that kind.

A contract records the **structure** of real traffic — key paths, types,
nullability, optionality — and never its values. That is what lets contracts be
recorded against real models and still be committed: no cube, dimension,
process, or server name is captured. Object names in request paths are replaced
with `'*'`, and names that arrive as *keys* rather than values are collapsed the
same way — a payload like `elementCounts` is a map of dimension name to count,
so it is recorded as `{"*": "number"}`. Without that second rule it committed
120 dimension names of the model it was recorded against; `collapseNameKeyedMaps`
in `tests/helpers/wire-contract.ts` applies it at merge time, and
`tests/unit/contract-no-model-names.test.ts` fails if a committed contract ever
spells such a map out again.

## The two files

| File | Records | Guards |
| --- | --- | --- |
| `wire-contracts.json` | HTTP response shape per endpoint | tests that stub `fetch` or `TM1HttpClient.request` |
| `service-contracts.json` | Return-value shape per service method | tests that fake `TM1Client` at the service level |

Two files because the suite fakes TM1 at two depths, and a fake is only pinned
by a contract taken at the same depth.

### Notation

```
key        key present in every observation
key?       key absent from at least one observation
key[]      key holds an array; the value is the merged element shape
"[]"       the value itself is an array (only meaningful at the root)
"a|b"      union of observed types, e.g. "string|null"
"unknown"  an array was seen here but it was always empty
```

Array elements are merged rather than sampled: TM1 omits keys per row, so a
contract built from element 0 alone would call element 1 a violation.

## Recording

```bash
npm run contracts:record                 # tm1-test, full live suite
node scripts/record-wire-contracts.mjs tm1-prod --read-only --merge
```

The recorder rides along with the live suite instead of probing a separate list
of endpoints — the live suite already drives ~35 tools including writes and
deliberate error paths, so what gets recorded is what the code actually sends.

The server is named from `.mcp.json`, never from `.env`: `.env` points at a
production instance and the full suite creates and deletes sandbox objects.
`--read-only` restricts the run to the read sweep, which is safe anywhere.

`--merge` folds a run into what is already on disk. That is how a sandbox
recording and a sweep of a populated model combine: the sandbox contributes the
write and error paths, the populated model contributes shapes a fresh sandbox
cannot produce — non-null cells, real data sources, elements with children.
Without merging, whichever ran last would silently narrow the contracts.

## Verifying

```bash
node scripts/record-wire-contracts.mjs tm1-test --verify
```

Runs the live suite and fails if the server no longer matches the contracts.
This is the half that keeps them honest: recording answers "what does TM1
send", verifying answers "does it still", and catches a version upgrade, a
v11/v12 difference, or a fixture that has quietly gone stale.

## `contract-exceptions.json`

A contract records what was *observed*, which is a subset of what TM1 can send.
A fake using an unobserved-but-real shape is correct and the contract is merely
thin. Each such case is reviewed once and written down with its reason;
anything not listed fails the build, so an invented field still cannot slip
through.

Every entry is also a to-do: widen the recording until the exception is
unnecessary, then delete it. Most current entries exist because the sandbox has
no ODBC process, no populated cube, and no LDAP configuration.
