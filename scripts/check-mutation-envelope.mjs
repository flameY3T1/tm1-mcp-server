#!/usr/bin/env node
// Verify mutation tools return their success envelope via actionResponse()
// (src/tools/format.ts) instead of hand-rolling the
// `{ content: [{ text: JSON.stringify({ success: true, ... }) }] }` shape.
//
// Why this gate exists: ~35 mutation tools used to hand-roll that envelope
// while the actionResponse() helper (which produces the byte-identical
// content + structuredContent payload) was used by only a handful. The
// hand-rolled form drifts easily (indentation via `null, 2`, forgotten
// structuredContent, subtly different field order) and duplicates the shape
// the helper already guarantees. This gate keeps the pattern from creeping
// back in as new mutation tools are added.
//
// Detected anti-patterns (both key on `success: true` as the first field of
// the stringified object — the project convention, mirrored by
// MutationResultSchema in src/tools/schemas/items-common.ts):
//   1) direct:  JSON.stringify({ success: true, ... })
//   2) via var: const payload = { success: true, ... };  JSON.stringify(payload)
//
// Fix: `return actionResponse({ success: true, ... });`
//
// Exit codes:
//   0  no hand-rolled success envelopes (outside the allowlist)
//   1  one or more mutation tools hand-roll the success envelope
import { readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { walk } from "./lib/scan-tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const toolsDir = join(root, "src", "tools");

// Files (relative to repo root) deliberately allowed to hand-roll their
// success envelope — e.g. a bespoke shape actionResponse() cannot reproduce
// byte-for-byte. EMPTY today: every mutation tool routes through
// actionResponse(). Add an entry ONLY with a comment explaining why the
// helper cannot express that tool's exact payload.
const ALLOWLIST = new Set([
  // "src/tools/<category>/<tool>.ts", // reason the helper can't reproduce it
]);

// `success: true` as the first key after the opening brace — matches both the
// single-line `{ success: true` and the multi-line `{\n  success: true` forms,
// and does NOT span into an unrelated JSON.stringify (e.g. an isError branch
// whose object starts with a different key).
const DIRECT_RE = /JSON\.stringify\(\s*\{\s*success\s*:\s*true\b/;
const VAR_DECL_RE = /const\s+([A-Za-z0-9_$]+)\s*=\s*\{\s*success\s*:\s*true\b/g;

const offenders = [];

for (const file of walk(toolsDir)) {
  const rel = relative(root, file);
  if (ALLOWLIST.has(rel)) continue;
  const src = readFileSync(file, "utf8");

  if (DIRECT_RE.test(src)) {
    offenders.push({ file: rel, kind: "JSON.stringify({ success: true, ... })" });
    continue;
  }
  for (const m of src.matchAll(VAR_DECL_RE)) {
    const name = m[1];
    if (new RegExp(`JSON\\.stringify\\(\\s*${name}\\s*\\)`).test(src)) {
      offenders.push({ file: rel, kind: `JSON.stringify(${name}) where ${name} = { success: true, ... }` });
      break;
    }
  }
}

if (offenders.length === 0) {
  console.log("check-mutation-envelope: OK (no hand-rolled success envelopes)");
  process.exit(0);
}

console.error(
  `\ncheck-mutation-envelope: ${offenders.length} mutation tool(s) hand-roll the success envelope:\n`,
);
for (const o of offenders.sort((a, b) => a.file.localeCompare(b.file))) {
  console.error(`  - ${o.file}   (${o.kind})`);
}
console.error(
  `\nFix: return the success payload via actionResponse() from src/tools/format.js,\n` +
    `     e.g. \`return actionResponse({ success: true, ... });\`. It produces the same\n` +
    `     content + structuredContent shape the SDK expects. If a tool's payload genuinely\n` +
    `     cannot be expressed by the helper, add its file to ALLOWLIST in this script with\n` +
    `     a comment explaining why.\n`,
);
process.exit(1);
