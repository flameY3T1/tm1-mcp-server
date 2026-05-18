#!/usr/bin/env node
// Scan src/tools/**/*.ts for `server.tool("name", "desc", ...)` calls and emit
// a markdown list. Run via `npm run tools:list` (stdout) or
// `npm run tools:update-readme` (rewrite README between sentinels).
//
// Sentinels in README.md:
//   <!-- TOOLS-AUTOGEN:START -->
//   <!-- TOOLS-AUTOGEN:END -->
//
// Drift prevention. Add `npm run tools:update-readme` to pre-commit.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scanTools } from "./lib/scan-tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const toolsDir = join(root, "src", "tools");

const groups = new Map();
let total = 0;
for (const t of scanTools(toolsDir)) {
  if (!groups.has(t.group)) groups.set(t.group, []);
  groups.get(t.group).push(t);
  total++;
}

function render(headingLevel = "#") {
  const lines = [];
  lines.push(`${headingLevel} Tools (${total})`, "");
  for (const [group, tools] of [...groups.entries()].sort()) {
    lines.push(`${headingLevel}# ${group} (${tools.length})`, "");
    for (const t of tools.sort((a, b) => a.name.localeCompare(b.name))) {
      const firstSentence = t.desc.split(". ")[0].slice(0, 160);
      lines.push(`- \`${t.name}\` — ${firstSentence}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

const writeReadme = process.argv.includes("--write-readme");

if (!writeReadme) {
  process.stdout.write(render("#") + "\n");
  process.exit(0);
}

const readmePath = join(root, "README.md");
const readme = readFileSync(readmePath, "utf8");
const START = "<!-- TOOLS-AUTOGEN:START -->";
const END = "<!-- TOOLS-AUTOGEN:END -->";
const startIdx = readme.indexOf(START);
const endIdx = readme.indexOf(END);

if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
  console.error(
    `gen-tool-list: missing sentinels in README.md. Add:\n\n${START}\n${END}\n`,
  );
  process.exit(1);
}

const before = readme.slice(0, startIdx + START.length);
const after = readme.slice(endIdx);
const block = `\n${render("##")}\n`;
const next = `${before}${block}${after}`;

if (next === readme) {
  console.log("README.md tool list already in sync.");
  process.exit(0);
}

writeFileSync(readmePath, next);
console.log(`README.md tool list updated (${total} tools).`);
