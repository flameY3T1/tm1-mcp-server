// Folds the recorder's spool into tests/fixtures/wire-contracts.json.
//
// Runs once, in the live suite's teardown, because each test file records in
// its own worker process. Merging (rather than last-write-wins) is what makes
// optionality real: the same endpoint observed across many calls yields keys
// present in some responses and absent from others, and only the merge can
// tell those apart from keys the server always sends.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collapseNameKeyedMaps,
  mergeShapes,
  type ContractFile,
  type Shape,
} from "../helpers/wire-contract.js";
import type { ServiceContractFile } from "../helpers/service-contract.js";
import { SPOOL, SERVICE_SPOOL } from "./contract-mode.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixtures", "wire-contracts.json");
const SERVICE_FIXTURE = join(here, "..", "fixtures", "service-contracts.json");

export function mergeSpooledContracts(version: string): void {
  if (!existsSync(SPOOL)) return;

  const merged = new Map<string, Shape>();
  let versions: string[] = [];

  // CONTRACTS_MERGE=1 folds this run into what is already on disk instead of
  // replacing it. That is how a sandbox recording and a read-only sweep of a
  // populated model combine: the sandbox contributes the write and error
  // paths, the populated model contributes the shapes a fresh sandbox can
  // never produce (non-null cells, real data sources, elements with children).
  // Without merging, whichever ran last would silently narrow the contracts.
  if (process.env.CONTRACTS_MERGE === "1" && existsSync(FIXTURE)) {
    const prev = JSON.parse(readFileSync(FIXTURE, "utf8")) as ContractFile;
    for (const [k, v] of Object.entries(prev.endpoints)) merged.set(k, v);
    versions = Array.isArray(prev.recordedAgainst)
      ? prev.recordedAgainst
      : [prev.recordedAgainst];
  }

  for (const line of readFileSync(SPOOL, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const { key, shape } = JSON.parse(line) as { key: string; shape: Shape };
    const prev = merged.get(key);
    merged.set(key, prev ? mergeShapes(prev, shape) : shape);
  }

  // A $batch response envelopes N unrelated sub-responses, so merging their
  // bodies produces a union of every endpoint that ever appeared in a batch —
  // a shape nothing conforms to and nothing violates. Pin the envelope
  // (id/status/headers) and leave the body opaque; the inner endpoints have
  // contracts of their own.
  const batch = merged.get("POST /api/v1/$batch");
  if (batch && typeof batch !== "string") {
    const responses = batch["responses[]"];
    if (responses && typeof responses !== "string") {
      merged.set("POST /api/v1/$batch", {
        ...batch,
        "responses[]": { ...responses, body: "unknown" },
      });
    }
  }

  const out: ContractFile = {
    recordedAgainst: [...new Set([...versions, version])].sort(),
    recordedAt: new Date().toISOString().slice(0, 10),
    endpoints: Object.fromEntries(
      [...merged.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, collapseNameKeyedMaps(v)] as const),
    ),
  };
  writeFileSync(FIXTURE, JSON.stringify(out, null, 2) + "\n");
  console.log(
    `wire contracts: ${merged.size} endpoints recorded against ${version}`,
  );
}

/**
 * Same fold, for the service-level spool. Kept separate from the wire merge
 * because the two contract files answer different questions and are consumed
 * by different guards.
 */
export function mergeSpooledServiceContracts(version: string): void {
  if (!existsSync(SERVICE_SPOOL)) return;

  const merged = new Map<string, Shape>();
  let versions: string[] = [];

  if (process.env.CONTRACTS_MERGE === "1" && existsSync(SERVICE_FIXTURE)) {
    const prev = JSON.parse(
      readFileSync(SERVICE_FIXTURE, "utf8"),
    ) as ServiceContractFile;
    for (const [k, v] of Object.entries(prev.methods)) merged.set(k, v);
    versions = prev.recordedAgainst;
  }

  for (const line of readFileSync(SERVICE_SPOOL, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const { key, shape } = JSON.parse(line) as { key: string; shape: Shape };
    const prev = merged.get(key);
    merged.set(key, prev ? mergeShapes(prev, shape) : shape);
  }

  const out: ServiceContractFile = {
    recordedAgainst: [...new Set([...versions, version])].sort(),
    recordedAt: new Date().toISOString().slice(0, 10),
    methods: Object.fromEntries(
      [...merged.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, collapseNameKeyedMaps(v)] as const),
    ),
  };
  writeFileSync(SERVICE_FIXTURE, JSON.stringify(out, null, 2) + "\n");
  console.log(`service contracts: ${merged.size} methods recorded`);
}
