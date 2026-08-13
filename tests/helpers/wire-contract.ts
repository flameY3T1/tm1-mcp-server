// Wire contracts: what TM1 actually puts on the wire, as structure only.
//
// The problem this solves: ~40 test files build TM1 responses by hand. Nothing
// checked those hand-written payloads against a real server, so a fake could
// grow a field TM1 never sends, or give a field the wrong type, and the suite
// stayed green while production read `undefined`. Both bugs that shipped and
// were caught only by live measurement were of exactly this kind.
//
// A contract records the *shape* of a real response — key paths, types,
// nullability, optionality — and never its values. That keeps customer and
// server names out of the repo (contracts are recorded against real models)
// while still pinning the part a fake can get wrong.
//
// Format, one entry per normalized endpoint:
//
//   "GET /api/v1/Cubes": {
//     "@odata.context": "string",
//     "value[]": { "Name": "string", "Dimensions[]": { "Name": "string" } }
//   }
//
//   key      required key
//   key?     key absent from at least one observed occurrence
//   key[]    key holds an array; the value is the merged element shape
//   "a|b"    union of observed types, e.g. "string|null"
//
// Recorded by scripts/record-wire-contracts.mjs; see tests/fixtures/README.md.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Shape = string | { [key: string]: Shape };

export interface ContractFile {
  /**
   * TM1 versions the contracts were recorded against. More than one entry
   * means the shapes are the union of what those servers sent — see
   * CONTRACTS_MERGE in tests/live/merge-contracts.ts.
   */
  recordedAgainst: string[];
  /** ISO date of the recording run. */
  recordedAt: string;
  endpoints: Record<string, Shape>;
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixtures", "wire-contracts.json");

let cached: ContractFile | undefined;

export function loadContracts(): ContractFile {
  cached ??= JSON.parse(readFileSync(FIXTURE, "utf8")) as ContractFile;
  return cached;
}

// ── Deriving a shape ──────────────────────────────────────────────────────

function typeNameOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Merge two observed type unions into one, keeping members sorted. */
function unionTypes(a: string, b: string): string {
  if (a === b) return a;
  const members = new Set([...a.split("|"), ...b.split("|")]);
  // "unknown" only means "an empty array was observed here" — any real
  // observation is strictly more informative, so it drops out of the union.
  if (members.size > 1) members.delete("unknown");
  return [...members].sort().join("|");
}

/**
 * Structural signature of a value. Objects recurse; arrays are collapsed to
 * one merged element shape, so `items: [{a:1},{a:1,b:2}]` yields
 * `{"a":"number","b?":"number"}` — the merge is what surfaces optionality.
 */
export function shapeOf(value: unknown): Shape {
  // A top-level array is wrapped so its array-ness survives. Inside an object
  // that fact rides on the key (`Elements[]`); at the root there is no key to
  // carry it, and a service method returning `CubeRules[]` would otherwise be
  // recorded as if it returned a single CubeRules.
  if (Array.isArray(value)) return { "[]": mergeArrayElements(value) };
  if (value !== null && typeof value === "object") {
    const out: Record<string, Shape> = {};
    for (const [k, v] of Object.entries(value)) {
      // `undefined` is not a wire value and not a claim — JSON cannot carry
      // it. Recording it as the type "undefined" would make the contract
      // demand that the key stay absent.
      if (v === undefined) continue;
      const key = Array.isArray(v) ? `${k}[]` : k;
      out[key] = Array.isArray(v) ? mergeArrayElements(v) : shapeOf(v);
    }
    return sortKeys(out);
  }
  return typeNameOf(value);
}

function mergeArrayElements(arr: unknown[]): Shape {
  if (arr.length === 0) return "unknown";
  return arr.map(shapeOf).reduce(mergeShapes);
}

/**
 * Merge two shapes observed at the same position. Keys seen in only one side
 * become optional; differing primitives become a union.
 */
export function mergeShapes(a: Shape, b: Shape): Shape {
  // "unknown" is the empty-array marker: it says "an array was here but it had
  // no elements to describe". Any real observation supersedes it outright —
  // folding it into a union instead would collapse the element shape to the
  // useless string "object" and make every later check pass vacuously.
  if (a === "unknown") return b;
  if (b === "unknown") return a;

  if (typeof a === "string" && typeof b === "string") return unionTypes(a, b);
  // A primitive merged with an object cannot be reconciled; record the union
  // so the divergence is visible rather than silently picking a winner.
  if (typeof a === "string" || typeof b === "string") {
    return unionTypes(
      typeof a === "string" ? a : "object",
      typeof b === "string" ? b : "object",
    );
  }

  const out: Record<string, Shape> = {};
  const baseA = new Map(Object.entries(a).map(([k, v]) => [stripOpt(k), v]));
  const baseB = new Map(Object.entries(b).map(([k, v]) => [stripOpt(k), v]));

  for (const key of new Set([...baseA.keys(), ...baseB.keys()])) {
    const inA = baseA.has(key);
    const inB = baseB.has(key);
    const merged =
      inA && inB
        ? mergeShapes(baseA.get(key)!, baseB.get(key)!)
        : (baseA.get(key) ?? baseB.get(key))!;
    // Optional if either side already marked it optional, or if one side
    // never saw it at all.
    const alreadyOptional =
      Object.keys(a).includes(`${key}?`) || Object.keys(b).includes(`${key}?`);
    out[!inA || !inB || alreadyOptional ? `${key}?` : key] = merged;
  }
  return sortKeys(out);
}

function stripOpt(key: string): string {
  return key.endsWith("?") ? key.slice(0, -1) : key;
}

function sortKeys(o: Record<string, Shape>): Record<string, Shape> {
  return Object.fromEntries(
    Object.entries(o).sort(([x], [y]) => x.localeCompare(y)),
  );
}

// ── Normalizing a request path to a contract key ──────────────────────────

/**
 * Collapse a concrete request into the endpoint key a contract is filed
 * under: object names and query strings are stripped, so
 * `GET /api/v1/Cubes('Sales')/Views?$top=5` files under
 * `GET /api/v1/Cubes('*')/Views`.
 *
 * Stripping names is not only normalization — it is what keeps real model
 * names out of the fixture.
 */
export function endpointKey(method: string, path: string): string {
  const noQuery = path.split("?")[0] ?? path;
  const normalized = noQuery
    .replace(/\('[^']*'\)/g, "('*')")
    .replace(/\(\d+\)/g, "(*)")
    // v12 reroots every call under the instance name (`/<instance>/api/v1/…`).
    // That name is deployment-specific — a customer's instance would otherwise
    // be committed in an endpoint key, which is exactly what recording shapes
    // instead of values is meant to avoid. The `/*/` marker still keeps v12
    // keys distinct from v11's bare `/api/v1/…`.
    .replace(/^\/[^/]+\/api\//, "/*/api/");
  return `${method.toUpperCase()} ${normalized}`;
}

// ── Checking a payload against a contract ─────────────────────────────────

export interface CheckOptions {
  /**
   * "subset" (default) — every key the payload carries must exist in the
   * contract with a compatible type, but the payload may omit keys. This is
   * the mode for hand-written fakes: `$select` legitimately trims responses,
   * so absence proves nothing, while a key the server never sends, or a
   * number where the server sends a string, is a real defect.
   *
   * "exact" — additionally, every required contract key must be present. For
   * live responses, where an absent key means the server changed.
   */
  mode?: "subset" | "exact";
}

/** Human-readable list of divergences; empty when the payload conforms. */
export function diffAgainstShape(
  payload: unknown,
  contract: Shape,
  opts: CheckOptions = {},
  path = "$",
): string[] {
  const mode = opts.mode ?? "subset";
  const problems: string[] = [];

  // Arrays first: a contract records one merged element shape, so an array
  // payload is always checked element-wise — including when that shape is a
  // primitive (`Statements[]: "string"`). Testing the array itself against
  // "string" would report every string array as a type error.
  if (Array.isArray(payload)) {
    // A root-level array contract is wrapped as `{ "[]": elementShape }` —
    // or `{ "[]?": ... }` once a merge has seen a method that sometimes
    // returns an object instead (an overload like `getAllRules`).
    const element =
      typeof contract !== "string"
        ? (contract["[]"] ?? contract["[]?"] ?? contract)
        : contract;
    payload.forEach((el, i) => {
      problems.push(...diffAgainstShape(el, element, opts, `${path}[${i}]`));
    });
    return problems;
  }

  if (typeof contract === "string") {
    const actual = typeNameOf(payload);
    if (contract === "unknown") return problems;
    // A contract of bare "null" carries no type claim, only "every sample the
    // recording happened to see was null" — the same empty observation that
    // "unknown" stands for on an empty array. TM1 has plenty of fields that
    // are null on one object and set on the next (a subset's Expression is
    // null while it is static, MDX once it is not), so treating that as a
    // type would make the contract report drift for the second object it ever
    // sees. A union that names a real type — "string|null" — still binds.
    if (contract === "null") return problems;
    const allowed = new Set(contract.split("|"));
    if (allowed.has("object") && actual === "object") return problems;
    if (!allowed.has(actual)) {
      problems.push(
        `${path}: contract says ${contract}, payload has ${actual}`,
      );
    }
    return problems;
  }

  if (payload === null || typeof payload !== "object") {
    problems.push(
      `${path}: contract says object, payload has ${typeNameOf(payload)}`,
    );
    return problems;
  }

  const byName = new Map<string, { shape: Shape; isArray: boolean }>();
  for (const [k, v] of Object.entries(contract)) {
    const bare = stripOpt(k);
    const isArray = bare.endsWith("[]");
    byName.set(isArray ? bare.slice(0, -2) : bare, { shape: v, isArray });
  }

  for (const [k, v] of Object.entries(payload)) {
    // An explicit `undefined` is the same claim as an absent key — JSON cannot
    // even express it. Common in service-level fakes built by spreading
    // optional fields.
    if (v === undefined) continue;
    const entry = byName.get(k);
    if (!entry) {
      // OData control information (`@odata.count`, `Elements@odata.nextLink`,
      // …) is protocol, not model: whether the server emits it depends on the
      // query options of the individual request, and contracts are filed per
      // endpoint with the query stripped. Demanding a recording of every
      // option combination would make the contract about our query building
      // rather than about TM1's payload shape.
      if (k.includes("@odata.")) continue;
      problems.push(
        `${path}.${k}: not in the recorded contract — the server does not send this key`,
      );
      continue;
    }
    if (entry.isArray && !Array.isArray(v)) {
      problems.push(
        `${path}.${k}: contract says array, payload has ${typeNameOf(v)}`,
      );
      continue;
    }
    if (!entry.isArray && Array.isArray(v)) {
      problems.push(
        `${path}.${k}: contract says scalar/object, payload has array`,
      );
      continue;
    }
    problems.push(...diffAgainstShape(v, entry.shape, opts, `${path}.${k}`));
  }

  if (mode === "exact") {
    for (const k of Object.keys(contract)) {
      if (k.endsWith("?")) continue;
      const name = k.endsWith("[]") ? k.slice(0, -2) : k;
      if (!(name in payload)) {
        problems.push(
          `${path}.${name}: required by the contract, missing from the payload`,
        );
      }
    }
  }

  return problems;
}

/**
 * Assert a payload conforms to the recorded contract for an endpoint.
 *
 * Throws with every divergence listed, so one run shows the whole gap rather
 * than one field per iteration.
 */
export function assertMatchesContract(
  endpoint: string,
  payload: unknown,
  opts: CheckOptions = {},
): void {
  const { endpoints } = loadContracts();
  const contract = endpoints[endpoint];
  if (!contract) {
    throw new Error(
      `no wire contract recorded for "${endpoint}". Record one with ` +
        `\`npm run contracts:record\`, or fix the endpoint key — see ` +
        `tests/fixtures/README.md.`,
    );
  }
  const problems = diffAgainstShape(payload, contract, opts);
  if (problems.length > 0) {
    throw new Error(
      `payload does not match the wire contract for "${endpoint}":\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }
}

/** True when a contract exists; for tests that skip rather than fail. */
export function hasContract(endpoint: string): boolean {
  return endpoint in loadContracts().endpoints;
}
