#!/usr/bin/env node
// Scan src/tools/**/*.ts for `server.tool("name", "desc", ...)` calls and emit
// a markdown list. Run via `npm run tools:list`. README drift prevention.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const toolsDir = join(root, "src", "tools");

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (entry.endsWith(".ts")) yield full;
  }
}

const TOOL_RE = /server\.tool\(\s*"([^"]+)"\s*,\s*"([^"]*(?:\\.[^"]*)*)"/g;

const groups = new Map();
let total = 0;
for (const file of walk(toolsDir)) {
  const src = readFileSync(file, "utf8");
  const rel = relative(toolsDir, file);
  const group = rel.split("/")[0];
  let m;
  while ((m = TOOL_RE.exec(src)) !== null) {
    const [, name, desc] = m;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ name, desc, file: rel });
    total++;
  }
}

console.log(`# Tools (${total})\n`);
for (const [group, tools] of [...groups.entries()].sort()) {
  console.log(`## ${group} (${tools.length})\n`);
  for (const t of tools.sort((a, b) => a.name.localeCompare(b.name))) {
    const firstSentence = t.desc.split(". ")[0].slice(0, 160);
    console.log(`- \`${t.name}\` — ${firstSentence}`);
  }
  console.log();
}
