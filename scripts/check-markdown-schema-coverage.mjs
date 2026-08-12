#!/usr/bin/env node
// Guard MARKDOWN_CAPABLE_TOOLS (src/tools/output-schema-map.ts) against drift.
//
// A tool that accepts FORMAT_SCHEMA can answer with a rendered Markdown table,
// which travels as `structuredContent: { markdown }`. That only validates if
// the tool's outputSchema was widened by `markdownCapable()` — otherwise the
// SDK rejects the response at runtime with
//   -32602 Invalid structured content ... expected <field>, received undefined
// and no type-check or unit test on the tool itself notices, because the JSON
// path (the default) keeps working. This gate is the only thing standing
// between "added format support" and a tool that 500s the moment someone
// passes format:"markdown".
//
// Exit codes:
//   0  the FORMAT_SCHEMA tool set and MARKDOWN_CAPABLE_TOOLS agree
//   1  a tool offers format:"markdown" without a widened schema, or vice versa
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { walk } from "./lib/scan-tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const toolsDir = join(root, "src", "tools");
const mapPath = join(toolsDir, "output-schema-map.ts");

// Tools opt into the markdown surface by spreading FORMAT_SCHEMA into their
// input shape. Attribution is per REGISTRATION, not per file: get-threads.ts
// registers both tm1_list_threads (paginated, format-capable) and
// tm1_cancel_thread (neither), so a file-level check would flag the wrong set.
// Each registration owns the source from its `server.tool(` to the next one.
const TOOL_NAME_RE = /server\.tool\(\s*"(tm1_[a-z0-9_]+)"/g;

function formatCapableTools() {
  const names = new Set();
  for (const file of walk(toolsDir)) {
    const src = readFileSync(file, "utf8");
    if (!src.includes("FORMAT_SCHEMA")) continue;
    const hits = [];
    let m;
    const re = new RegExp(TOOL_NAME_RE.source, "g");
    while ((m = re.exec(src)) !== null) {
      hits.push({ name: m[1], start: m.index });
    }
    for (let i = 0; i < hits.length; i++) {
      const end = i + 1 < hits.length ? hits[i + 1].start : src.length;
      if (src.slice(hits[i].start, end).includes("FORMAT_SCHEMA")) {
        names.add(hits[i].name);
      }
    }
  }
  return names;
}

function declaredMarkdownTools() {
  const src = readFileSync(mapPath, "utf8");
  const block = src.match(
    /MARKDOWN_CAPABLE_TOOLS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/,
  );
  if (!block) {
    console.error(
      "check-markdown-schema-coverage: MARKDOWN_CAPABLE_TOOLS not found in output-schema-map.ts",
    );
    process.exit(1);
  }
  const names = new Set();
  let m;
  const re = /"(tm1_[a-z0-9_]+)"/g;
  while ((m = re.exec(block[1])) !== null) names.add(m[1]);
  return names;
}

const actual = formatCapableTools();
const declared = declaredMarkdownTools();

const missing = [...actual].filter((n) => !declared.has(n)).sort();
const extra = [...declared].filter((n) => !actual.has(n)).sort();

if (missing.length === 0 && extra.length === 0) {
  console.log(
    `check-markdown-schema-coverage: OK (${declared.size} markdown-capable tools)`,
  );
  process.exit(0);
}

console.error(
  "\ncheck-markdown-schema-coverage: MARKDOWN_CAPABLE_TOOLS drift\n",
);
for (const n of missing) {
  console.error(`  - ${n} accepts FORMAT_SCHEMA but is not markdown-capable`);
}
for (const n of extra) {
  console.error(`  - ${n} is listed but no longer accepts FORMAT_SCHEMA`);
}
console.error(
  `\nFix: update MARKDOWN_CAPABLE_TOOLS in src/tools/output-schema-map.ts so it`,
);
console.error(
  `     matches the tools that spread FORMAT_SCHEMA into their input shape.`,
);
process.exit(1);
