#!/usr/bin/env node
// Guard the serialized size of every published outputSchema against creep.
//
// The server's tools/list payload is dominated by tool schemas; the
// outputSchemas alone serialize to ~69KB of JSON that ships on every session.
// There was no gate stopping that number from drifting upward one schema at a
// time. This script sums the exact bytes the SDK emits for each entry in
// OUTPUT_SCHEMA_MAP and fails the build if the total crosses BUDGET_BYTES.
//
// It measures the SHIPPED bytes, not an approximation: it reuses the SDK's own
// `normalizeObjectSchema` + `toJsonSchemaCompat` (the exact functions McpServer
// calls in setToolRequestHandlers) so the number matches the wire payload
// byte-for-byte. That requires executing the Zod schemas, so it imports the
// BUILT map from dist/ (the coverage gate can regex src/; this one cannot).
// If dist is missing it builds once, so `node scripts/check-output-schema-budget.mjs`
// works standalone with no TM1 server.
//
// Exit codes:
//   0  total serialized outputSchema bytes <= BUDGET_BYTES
//   1  over budget (or dist could not be produced)
import { existsSync, statSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Current total is ~78.6KB (114 schemas). Budget = round number a few % above
// that, so ordinary additions pass but a runaway new schema (or a sloppy
// .describe() spree) trips the gate. Re-baseline deliberately when a real
// feature needs it — e.g. G1 typed the recursive tm1_analyze_callgraph output
// schema (was z.unknown()/passthrough, now ~6.3KB) to close the drift-guard
// blind spot, which lifted the total past the previous 78KB baseline.
const BUDGET_BYTES = 82_000;

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const mapPath = join(root, "dist", "tools", "output-schema-map.js");
const sdkServerDir = join(
  root,
  "node_modules",
  "@modelcontextprotocol",
  "sdk",
  "dist",
  "esm",
  "server",
);

// The gate executes compiled schemas, so it needs dist to reflect current src.
// `npm run verify` typechecks with --noEmit (never emits), so a plain `tsc` edit
// leaves dist stale and the gate would measure OLD bytes and pass a real bloat
// regression. Rebuild when dist is missing OR older than any src/*.ts file, so
// the measured number always matches what would actually ship.
function newestSrcMtimeMs() {
  const srcDir = join(root, "src");
  let newest = 0;
  for (const rel of readdirSync(srcDir, { recursive: true })) {
    if (typeof rel !== "string" || !rel.endsWith(".ts")) continue;
    const m = statSync(join(srcDir, rel)).mtimeMs;
    if (m > newest) newest = m;
  }
  return newest;
}

function build(reason) {
  console.error(`check-output-schema-budget: ${reason} — running \`npm run build\`…`);
  try {
    execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  } catch {
    console.error(
      "check-output-schema-budget: build failed; cannot measure outputSchema bytes.",
    );
    process.exit(1);
  }
}

if (!existsSync(mapPath)) {
  build("dist not built");
} else if (newestSrcMtimeMs() > statSync(mapPath).mtimeMs) {
  build("dist stale vs src");
}
if (!existsSync(mapPath)) {
  console.error(
    `check-output-schema-budget: expected ${mapPath} after build, not found.`,
  );
  process.exit(1);
}

let normalizeObjectSchema, toJsonSchemaCompat;
try {
  ({ normalizeObjectSchema } = await import(
    pathToFileURL(join(sdkServerDir, "zod-compat.js")).href
  ));
  ({ toJsonSchemaCompat } = await import(
    pathToFileURL(join(sdkServerDir, "zod-json-schema-compat.js")).href
  ));
} catch (err) {
  console.error(
    "check-output-schema-budget: could not load the SDK schema serializers — the " +
      "@modelcontextprotocol/sdk internal layout likely changed. Update the import " +
      "paths in this script to match the new SDK version.",
  );
  console.error(String(err?.message ?? err));
  process.exit(1);
}
const { OUTPUT_SCHEMA_MAP } = await import(pathToFileURL(mapPath).href);

// Same options McpServer passes when it serializes outputSchema for tools/list.
const JSON_SCHEMA_OPTS = { strictUnions: true, pipeStrategy: "output" };

const rows = [];
let total = 0;
for (const [name, schema] of Object.entries(OUTPUT_SCHEMA_MAP)) {
  const obj = normalizeObjectSchema(schema);
  const jsonSchema = toJsonSchemaCompat(obj, JSON_SCHEMA_OPTS);
  const bytes = Buffer.byteLength(JSON.stringify(jsonSchema), "utf8");
  rows.push({ name, bytes });
  total += bytes;
}
rows.sort((a, b) => b.bytes - a.bytes);

const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
const pct = ((total / BUDGET_BYTES) * 100).toFixed(1);

if (total <= BUDGET_BYTES) {
  console.log(
    `✓ outputSchema budget OK: ${total} bytes (${kb(total)}) across ${rows.length} schemas ` +
      `— ${pct}% of ${BUDGET_BYTES}-byte budget`,
  );
  process.exit(0);
}

console.error(
  `\n✖ outputSchema budget exceeded: ${total} bytes (${kb(total)}) across ${rows.length} schemas ` +
    `> ${BUDGET_BYTES}-byte budget (over by ${total - BUDGET_BYTES}).\n`,
);
console.error("Largest outputSchemas (top 5):");
for (const r of rows.slice(0, 5)) {
  console.error(`  - ${String(r.bytes).padStart(5)} bytes  ${r.name}`);
}
console.error(
  `\nFix: trim a schema (shorter .describe() text, drop redundant fields), or if the\n` +
    `     growth is intentional, raise BUDGET_BYTES in scripts/check-output-schema-budget.mjs.`,
);
process.exit(1);
