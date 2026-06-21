#!/usr/bin/env node
// Guard OUTPUT_SCHEMA_MAP (src/tools/output-schema-map.ts) against drift.
//
// The annotation map is policed by check-annotation-coverage.mjs, but the
// output-schema map — the one that drives `additionalProperties:false`
// structuredContent validation — had no gate. A stale key (tool renamed or
// removed) lingers silently; a key for a tool that no longer exists is dead
// weight that can mask a real registration mistake.
//
// This script fails the build when OUTPUT_SCHEMA_MAP contains a key with no
// matching server.tool() registration. (It does NOT require every tool to
// have a schema — text-only tools legitimately have none — so the "missing"
// direction is intentionally not enforced.)
//
// Exit codes:
//   0  every OUTPUT_SCHEMA_MAP key maps to a registered tool
//   1  one or more stale keys
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scanTools } from "./lib/scan-tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const toolsDir = join(root, "src", "tools");
const mapPath = join(toolsDir, "output-schema-map.ts");

// Match map entries like:
//   tm1_search_code: asOutputSchema(SearchCodeResultSchema),
//   tm1_write_cells: MutationResultSchema,
// Anchored to indented `tm1_*:` lines, so schema imports (PascalCase) and the
// `OUTPUT_SCHEMA_MAP` declaration itself are not matched.
const KEY_RE = /^\s+(tm1_[a-z0-9_]+)\s*:/gm;

function readSchemaKeys() {
  const src = readFileSync(mapPath, "utf8");
  const keys = new Set();
  let m;
  while ((m = KEY_RE.exec(src)) !== null) keys.add(m[1]);
  return keys;
}

const registeredNames = new Set(scanTools(toolsDir).map((t) => t.name));
const schemaKeys = readSchemaKeys();

const stale = [];
for (const key of schemaKeys) {
  if (!registeredNames.has(key)) stale.push(key);
}

if (stale.length === 0) {
  console.log(
    `check-output-schema-coverage: OK (${schemaKeys.size} output-schema keys, all registered)`,
  );
  process.exit(0);
}

console.error(
  `\ncheck-output-schema-coverage: ${stale.length} OUTPUT_SCHEMA_MAP key(s) without a matching registration:\n`,
);
for (const k of stale.sort()) console.error(`  - ${k}`);
console.error(
  `\nFix: remove the stale key from OUTPUT_SCHEMA_MAP in src/tools/output-schema-map.ts,`,
);
console.error(`     or restore the missing server.tool() registration.`);
process.exit(1);
