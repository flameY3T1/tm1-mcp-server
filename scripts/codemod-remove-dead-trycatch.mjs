#!/usr/bin/env node
// Codemod for backlog #2: remove dead try/catch wrappers in tool registrations.
//
// The MCP proxy in src/index.ts (wrapCb -> formatTm1ErrorResult) already
// catches thrown errors and emits a uniform error envelope. Per-tool try/catch
// blocks that just rebuild the envelope manually are pure noise.
//
// Strategy:
//   1. Walk src/tools/**/*.ts.
//   2. For each file with EXACTLY ONE `error instanceof TM1Error` sentinel
//      (i.e. a single trivial catch), find the surrounding `try { ... } catch
//      (error) { ... }` and unwrap it into just the try-body, dedented.
//   3. Verify the catch body matches the boilerplate (`const msg`, `isError:
//      true`). If not, skip — don't touch domain logic.
//   4. Drop the `import { TM1Error } from ...` line if no other reference
//      remains in the file.
//
// Run:
//   node scripts/codemod-remove-dead-trycatch.mjs        # dry-run (default)
//   node scripts/codemod-remove-dead-trycatch.mjs --apply
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const toolsDir = path.join(root, "src", "tools");
const APPLY = process.argv.includes("--apply");

function* walk(dir) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const s = fs.statSync(full);
    if (s.isDirectory()) yield* walk(full);
    else if (entry.endsWith(".ts")) yield full;
  }
}

// Brace-aware forward search ignoring strings, template literals, and comments.
function findMatchingBrace(text, openIdx) {
  let depth = 0;
  let inString = null;
  let inTemplate = false;
  let escape = false;
  let inLine = false;
  let inBlock = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (inLine) { if (c === "\n") inLine = false; continue; }
    if (inBlock) {
      if (c === "*" && text[i + 1] === "/") { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      if (c === "\\") { escape = true; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (inTemplate) {
      if (c === "\\") { escape = true; continue; }
      if (c === "`") inTemplate = false;
      continue;
    }
    if (c === '"' || c === "'") { inString = c; continue; }
    if (c === "`") { inTemplate = true; continue; }
    if (c === "/" && text[i + 1] === "/") { inLine = true; i++; continue; }
    if (c === "/" && text[i + 1] === "*") { inBlock = true; i++; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function processFile(src) {
  const SENTINEL = "error instanceof TM1Error";
  const first = src.indexOf(SENTINEL);
  if (first < 0) return { changed: false };
  if (src.indexOf(SENTINEL, first + SENTINEL.length) > 0) {
    return { changed: false, skipped: "multiple TM1Error sentinels" };
  }

  // Find the `} catch (error) {` immediately before the sentinel.
  const catchRe = /\}\s*catch\s*\(\s*error\s*\)\s*\{/g;
  let m;
  let lastCatch = null;
  while ((m = catchRe.exec(src)) !== null) {
    if (m.index < first) lastCatch = m;
    else break;
  }
  if (!lastCatch) return { changed: false, skipped: "no matching catch" };

  const catchOpenIdx = lastCatch.index + lastCatch[0].length - 1;
  const catchCloseIdx = findMatchingBrace(src, catchOpenIdx);
  if (catchCloseIdx < 0) return { changed: false, skipped: "unmatched catch brace" };
  const catchBody = src.slice(catchOpenIdx + 1, catchCloseIdx);

  // Boilerplate sanity: should contain `const msg` AND `isError: true`.
  if (!/const\s+msg\s*=/.test(catchBody)) {
    return { changed: false, skipped: "non-boilerplate catch (no const msg)" };
  }
  if (!/isError\s*:\s*true/.test(catchBody)) {
    return { changed: false, skipped: "non-boilerplate catch (no isError)" };
  }

  // Find the matching `try {` whose closing brace lives at `lastCatch.index`.
  const tryStart = src.lastIndexOf("try {", lastCatch.index);
  if (tryStart < 0) return { changed: false, skipped: "no try keyword" };
  const tryOpenIdx = src.indexOf("{", tryStart);
  const tryCloseIdx = findMatchingBrace(src, tryOpenIdx);
  if (tryCloseIdx !== lastCatch.index) {
    return { changed: false, skipped: "try/catch braces mismatched (nested?)" };
  }

  const tryBody = src.slice(tryOpenIdx + 1, tryCloseIdx);

  // Dedent body: drop two spaces of leading indent, preserving relative shape.
  const lineStart = src.lastIndexOf("\n", tryStart) + 1;
  const outerIndent = src.slice(lineStart, tryStart);
  const bodyIndent = outerIndent + "  ";
  const dedented = tryBody
    .split("\n")
    .map((l) => (l.startsWith(bodyIndent) ? l.slice(2) : l))
    .join("\n");
  // Strip leading "\n" right after `try {` and trailing whitespace before `}`.
  let cleanBody = dedented.replace(/^\n/, "").replace(/\n[ \t]*$/, "");

  // The first surviving line still carries the (now-outer) indent. Outer
  // context (`before`) ends with `outerIndent + "try "`, so strip the indent
  // from the first body line to avoid double-indent.
  const lines = cleanBody.split("\n");
  if (lines[0] !== undefined) lines[0] = lines[0].replace(/^[ \t]+/, "");
  cleanBody = lines.join("\n");

  let next = src.slice(0, tryStart) + cleanBody + src.slice(catchCloseIdx + 1);

  // Drop the TM1Error import if no other reference remains.
  if (!/\bTM1Error\b/.test(next.replace(/from\s+["'][^"']*["']/g, ""))) {
    next = next.replace(
      /^import\s*\{\s*TM1Error\s*\}\s*from\s*["'][^"']+["'];\s*\n/m,
      "",
    );
    // Compound import like `import { Foo, TM1Error } from ...` — strip the name.
    next = next.replace(
      /(import\s*\{\s*[^}]*?)\bTM1Error\s*,?\s*([^}]*\}\s*from\s*["'][^"']+["'];)/m,
      (_, a, b) => `${a}${b}`.replace(/,\s*\}/, " }"),
    );
  }

  return { changed: next !== src, next };
}

let modified = 0;
const skips = [];
for (const file of walk(toolsDir)) {
  const src = fs.readFileSync(file, "utf8");
  const result = processFile(src);
  if (result.skipped) skips.push({ file: path.relative(root, file), reason: result.skipped });
  if (!result.changed) continue;
  modified++;
  if (APPLY) {
    fs.writeFileSync(file, result.next);
    console.log(`[apply] ${path.relative(root, file)}`);
  } else {
    console.log(`[dry] ${path.relative(root, file)}`);
  }
}

console.log(`\n${APPLY ? "Applied" : "Would modify"}: ${modified} files`);
if (skips.length > 0) {
  console.log(`Skipped (kept as-is): ${skips.length}`);
  for (const s of skips) console.log(`  ${s.file} — ${s.reason}`);
}
