// Shared scanner for `server.tool("name", "desc", ...)` registrations under
// src/tools/**/*.ts. Used by gen-tool-list.mjs and check-annotation-coverage.mjs.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export function* walk(dir) {
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
export const TOOL_RE =
  /server\.tool\(\s*"([^"]+)"\s*,\s*(?:"((?:[^"\\]|\\.)*)"|\[([\s\S]*?)\]\s*\.join\(\s*"((?:[^"\\]|\\.)*)"\s*\))/g;
const STRING_LITERAL_RE = /"((?:[^"\\]|\\.)*)"/g;

export function scanTools(toolsDir) {
  const tools = [];
  for (const file of walk(toolsDir)) {
    const src = readFileSync(file, "utf8");
    const rel = relative(toolsDir, file);
    const group = rel.split("/")[0];
    const re = new RegExp(TOOL_RE.source, "g");
    let m;
    while ((m = re.exec(src)) !== null) {
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
      tools.push({ name, desc, file: rel, group });
    }
  }
  return tools;
}
