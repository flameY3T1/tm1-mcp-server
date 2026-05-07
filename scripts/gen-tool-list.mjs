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
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

// Match either:
//   server.tool("name", "desc", ...)
//   server.tool("name", [ "line1", "line2" ].join("..."), ...)
// First-arg name is captured; desc form is captured as either literal or
// array-of-literals joined by separator.
const TOOL_RE =
  /server\.tool\(\s*"([^"]+)"\s*,\s*(?:"((?:[^"\\]|\\.)*)"|\[([\s\S]*?)\]\s*\.join\(\s*"((?:[^"\\]|\\.)*)"\s*\))/g;
const STRING_LITERAL_RE = /"((?:[^"\\]|\\.)*)"/g;

const groups = new Map();
let total = 0;
for (const file of walk(toolsDir)) {
  const src = readFileSync(file, "utf8");
  const rel = relative(toolsDir, file);
  const group = rel.split("/")[0];
  let m;
  while ((m = TOOL_RE.exec(src)) !== null) {
    const [, name, descLiteral, arrBody, sep] = m;
    let desc;
    if (descLiteral !== undefined) {
      desc = descLiteral;
    } else {
      const parts = [];
      let lm;
      const lr = new RegExp(STRING_LITERAL_RE.source, "g");
      while ((lm = lr.exec(arrBody)) !== null) parts.push(lm[1]);
      desc = parts.join(sep);
    }
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ name, desc, file: rel });
    total++;
  }
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
