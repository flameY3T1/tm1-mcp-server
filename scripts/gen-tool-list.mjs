#!/usr/bin/env node
// Scan src/tools/**/*.ts for `server.tool("name", "desc", ...)` calls and emit
// a markdown list.
//
//   npm run tools:list           -> print the full list to stdout
//   npm run tools:update-readme  -> write BOTH generated blocks in one run:
//                                     docs/TOOLS.md  full list, grouped
//                                     README.md      compact category table
//
// Both files carry the same sentinels; only the text between them is replaced,
// so hand-written prose around the block survives:
//   <!-- TOOLS-AUTOGEN:START -->
//   <!-- TOOLS-AUTOGEN:END -->
//
// This is manual — no CI gate. Run it after adding, removing or renaming a tool.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scanTools } from "./lib/scan-tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const toolsDir = join(root, "src", "tools");

const START = "<!-- TOOLS-AUTOGEN:START -->";
const END = "<!-- TOOLS-AUTOGEN:END -->";

const groups = new Map();
let total = 0;
for (const t of scanTools(toolsDir)) {
  if (!groups.has(t.group)) groups.set(t.group, []);
  groups.get(t.group).push(t);
  total++;
}
const sorted = [...groups.entries()].sort();

/** Full list: every tool with its first description sentence, grouped. */
function render(headingLevel = "#") {
  const lines = [];
  lines.push(`${headingLevel} Tools (${total})`, "");
  for (const [group, tools] of sorted) {
    lines.push(`${headingLevel}# ${group} (${tools.length})`, "");
    for (const t of tools.sort((a, b) => a.name.localeCompare(b.name))) {
      // .trim(): the 160-char slice can land mid-space, and a trailing space
      // would make the generated file fail `prettier --check`.
      const firstSentence = t.desc.split(". ")[0].slice(0, 160).trim();
      lines.push(`- \`${t.name}\` — ${firstSentence}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Compact table for the README: category, count, total, link to the detail. */
function renderCompact() {
  const lines = [];
  lines.push(`## Tools (${total})`, "");
  lines.push(
    "Names and one-line descriptions: [docs/TOOLS.md](docs/TOOLS.md).",
    "",
  );
  lines.push("| Category | Tools |", "|---|---|");
  for (const [group, tools] of sorted) {
    lines.push(`| ${group} | ${tools.length} |`);
  }
  lines.push(`| **Total** | **${total}** |`, "");
  return lines.join("\n");
}

const writeFiles = process.argv.includes("--write-readme");

if (!writeFiles) {
  process.stdout.write(render("#") + "\n");
  process.exit(0);
}

/**
 * Replace the text between the sentinels in `file` with `block`.
 * Returns true when the file changed.
 */
function writeBlock(path, label, block, extra = (s) => s) {
  const before = readFileSync(path, "utf8");
  const startIdx = before.indexOf(START);
  const endIdx = before.indexOf(END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    console.error(
      `gen-tool-list: missing sentinels in ${label}. Add:\n\n${START}\n${END}\n`,
    );
    process.exit(1);
  }
  const head = before.slice(0, startIdx + START.length);
  const tail = before.slice(endIdx);
  // Blank line on both sides of the block: prettier requires one between an
  // HTML comment and the markdown that follows it.
  const next = extra(`${head}\n\n${block}\n${tail}`);
  if (next === before) {
    console.log(`${label} already in sync.`);
    return false;
  }
  writeFileSync(path, next);
  console.log(`${label} updated (${total} tools).`);
  return true;
}

writeBlock(join(root, "docs", "TOOLS.md"), "docs/TOOLS.md", render("##"));
writeBlock(
  join(root, "README.md"),
  "README.md tool table",
  renderCompact(),
  // Keep the prose tool count (outside the sentinels) in sync; the category
  // count is derived from the same scan.
  (s) =>
    s.replace(
      /\b\d+ tools across \d+ categories\b/g,
      `${total} tools across ${sorted.length} categories`,
    ),
);
