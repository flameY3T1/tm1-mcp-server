#!/usr/bin/env node
// Verify every tool registrar is actually wired into src/tools/index.ts.
//
// Each tool file exports one `export function registerXxx(server, tm1Client)`.
// index.ts imports it and lists it in the REGISTRARS array. A new tool file
// that is never imported there compiles fine and even passes the annotation /
// output-schema gates (those scan tool files, not the wiring) — but the tool
// is never registered at runtime. This script closes that gap: every
// `register*` export under src/tools/ must be referenced in index.ts. (The
// reverse — referenced but not exported — is already a compile error, and
// imported-but-not-in-REGISTRARS is an eslint no-unused-vars error.)
//
// Exit codes:
//   0  every registrar is wired
//   1  one or more registrars missing from index.ts
import { readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { walk } from "./lib/scan-tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const toolsDir = join(root, "src", "tools");
const indexPath = join(toolsDir, "index.ts");

const EXPORT_RE = /export\s+function\s+(register[A-Za-z0-9_]+)\s*\(/g;

const indexSrc = readFileSync(indexPath, "utf8");
const missing = [];

for (const file of walk(toolsDir)) {
  if (file === indexPath) continue;
  const src = readFileSync(file, "utf8");
  let m;
  const re = new RegExp(EXPORT_RE.source, "g");
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    // Word-boundary match so registerFoo doesn't satisfy registerFooBar.
    const referenced = new RegExp(`\\b${name}\\b`).test(indexSrc);
    if (!referenced) {
      missing.push({ name, file: relative(root, file) });
    }
  }
}

if (missing.length === 0) {
  console.log("✓ every tool registrar is wired into src/tools/index.ts");
  process.exit(0);
}

console.error(
  `\n✖ ${missing.length} tool registrar(s) exported but not wired into src/tools/index.ts:\n`,
);
for (const v of missing.sort((a, b) => a.name.localeCompare(b.name))) {
  console.error(`  - ${v.name}   (${v.file})`);
}
console.error(
  `\nFix: import the function and add it to the REGISTRARS array in src/tools/index.ts.\n`,
);
process.exit(1);
