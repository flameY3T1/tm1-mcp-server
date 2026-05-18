#!/usr/bin/env node
// Verify every server.tool(...) registration under src/tools has a matching
// key in ANNOTATION_MAP (src/tools/annotation-map.ts). Without this, the
// server crashes at startup with:
//   "Tool <name> registered without annotation — add it to ANNOTATION_MAP"
// (thrown in src/index.ts around line 129). This script catches the
// mismatch at build-time instead of runtime.
//
// Exit codes:
//   0  all registered tools are covered
//   1  one or more tools missing from ANNOTATION_MAP (or unused keys present)
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scanTools } from "./lib/scan-tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const toolsDir = join(root, "src", "tools");
const annotationMapPath = join(toolsDir, "annotation-map.ts");

// Parse ANNOTATION_MAP keys via regex. Pattern matches lines like:
//   tm1_analyze_callgraph: READ_ONLY,
//   tm1_check_v12_readiness: withVersion(READ_ONLY, "v11"),
const KEY_RE = /^\s+(tm1_[a-z0-9_]+)\s*:/gm;

function readAnnotationKeys() {
  const src = readFileSync(annotationMapPath, "utf8");
  const keys = new Set();
  let m;
  while ((m = KEY_RE.exec(src)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

const registered = scanTools(toolsDir);
const registeredNames = new Set(registered.map((t) => t.name));
const annotationKeys = readAnnotationKeys();

const missing = [];
for (const t of registered) {
  if (!annotationKeys.has(t.name)) {
    missing.push(t);
  }
}

const unused = [];
for (const key of annotationKeys) {
  if (!registeredNames.has(key)) {
    unused.push(key);
  }
}

if (missing.length === 0 && unused.length === 0) {
  console.log(
    `check-annotation-coverage: OK (${registered.length} tools, ${annotationKeys.size} annotations)`,
  );
  process.exit(0);
}

if (missing.length > 0) {
  console.error(
    `\ncheck-annotation-coverage: ${missing.length} tool(s) missing from ANNOTATION_MAP:\n`,
  );
  for (const t of missing.sort((a, b) => a.name.localeCompare(b.name))) {
    console.error(`  - ${t.name}   (${t.file})`);
  }
  console.error(
    `\nFix: add an entry to ANNOTATION_MAP in src/tools/annotation-map.ts`,
  );
  console.error(
    `     Pick one of: READ_ONLY | IDEMPOTENT_WRITE | WRITE | DESTRUCTIVE`,
  );
}

if (unused.length > 0) {
  console.error(
    `\ncheck-annotation-coverage: ${unused.length} ANNOTATION_MAP key(s) without a matching registration:\n`,
  );
  for (const k of unused.sort()) {
    console.error(`  - ${k}`);
  }
  console.error(
    `\nFix: remove the stale key, or restore the missing server.tool() registration.`,
  );
}

process.exit(1);
