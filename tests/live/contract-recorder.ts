// Records wire contracts while the live suite runs.
//
// Rather than maintain a separate list of endpoints to probe — which would
// drift from what the code actually calls — recording rides along with the
// live suite: it already drives ~35 tools end to end, including sandbox
// writes and deliberate error paths, so whatever the client really sends is
// what gets recorded.
//
// Enabled only with RECORD_CONTRACTS=1 (`npm run contracts:record`); otherwise
// this file installs nothing and the live suite behaves exactly as before.
//
// Each worker appends one JSON line per observed response; the merge into
// tests/fixtures/wire-contracts.json happens once in global-setup's teardown,
// because vitest runs each test file in its own process.
//
// ── Why the import order below matters ────────────────────────────────────
// src/tm1-client/dispatcher.ts captures `globalThis.fetch` at module load and
// routes through it only when the global has since been replaced (that is the
// hook unit tests use); otherwise it calls npm undici's `fetch` directly, so
// that the undici Agent and the Headers implementation come from the same
// instance — pairing Node's built-in fetch with an npm Agent silently drops
// Set-Cookie and breaks auth.
//
// A naive patch here would be installed BEFORE that module loads, so the
// dispatcher would capture the patched function as its "built-in", find the
// identity unchanged, and bypass it. Importing the dispatcher first pins the
// real built-in; the patch then differs from it, so TM1 requests route through
// this wrapper — which forwards to the very same npm undici fetch, keeping the
// dispatcher and cookie behaviour the recording is supposed to observe rather
// than change.
import { appendFileSync } from "node:fs";
import { fetch as undiciFetch } from "undici";
import "../../src/tm1-client/dispatcher.js";
import { afterAll } from "vitest";
import {
  shapeOf,
  endpointKey,
  diffAgainstShape,
  loadContracts,
} from "../helpers/wire-contract.js";
import { isExcused } from "../helpers/contract-exceptions.js";
import { RECORDING, SPOOL } from "./contract-mode.js";

function record(method: string, href: string, status: number, body: string) {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;
  const path = new URL(href).pathname;
  // A failed response is a contract too: the 400 envelope TM1 returns for
  // "element already exists" is exactly the kind of shape a hand-written fake
  // gets wrong. Status-qualify the key so success and failure never merge.
  const key =
    status >= 200 && status < 300
      ? endpointKey(method, path)
      : `${endpointKey(method, path)} !${status}`;
  appendFileSync(
    SPOOL,
    JSON.stringify({ key, shape: shapeOf(JSON.parse(trimmed)) }) + "\n",
  );
}

// ── Drift detection: the default mode ─────────────────────────────────────
//
// Recording answers "what does TM1 send". The inverse — "does TM1 still send
// that" — is what catches a server upgrade, a v11/v12 difference, or a
// contract file that has quietly gone stale, and it is the half that makes the
// contracts trustworthy rather than merely present. Every ordinary live run
// checks it: the same wrapper compares instead of writing.
//
// The comparison is "exact": the contract was recorded from this very request
// shape, so a required key going missing is drift, not a narrower $select.
const drift: string[] = [];

function checkDrift(
  method: string,
  href: string,
  status: number,
  body: string,
) {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;
  const base = endpointKey(method, new URL(href).pathname);
  const key = status >= 200 && status < 300 ? base : `${base} !${status}`;
  const contract = loadContracts().endpoints[key];
  // No contract simply means the recording never covered this endpoint.
  if (!contract) return;
  const problems = diffAgainstShape(JSON.parse(trimmed), contract, {
    mode: "exact",
  }).filter((p) => !isExcused(key, p));
  if (problems.length > 0) drift.push(`${key}\n    ${problems.join("\n    ")}`);
}

globalThis.fetch = async (input: unknown, init?: RequestInit) => {
  const href =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;
  const res = await undiciFetch(
    href,
    init as unknown as Parameters<typeof undiciFetch>[1],
  );
  try {
    const text = await res.clone().text();
    if (RECORDING) record(init?.method ?? "GET", href, res.status, text);
    else checkDrift(init?.method ?? "GET", href, res.status, text);
  } catch {
    // Observing must never break the run it observes.
  }
  return res;
};

if (!RECORDING) {
  afterAll(() => {
    if (drift.length === 0) return;
    throw new Error(
      `the server no longer matches the recorded wire contracts:\n\n  ` +
        [...new Set(drift)].join("\n\n  ") +
        `\n\nEither TM1 changed — a different version, or a real behaviour ` +
        `change worth knowing about — or the contracts are stale. Re-record ` +
        `with \`npm run contracts:record\` and read the diff before ` +
        `committing it.`,
    );
  });
}
