import { promises as fs } from "node:fs";
import { resolveLocalPath } from "../local-file.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { parseProFile } from "../../lib/pro-parser.js";
import { buildProcessEnv, type ProcessEnv } from "../../lib/callgraph/variableEnv.js";

interface RefIssue {
  kind: "cube" | "dimension";
  name: string;
  tab: "prolog" | "metadata" | "data" | "epilog";
  line: number;
  context: string;
}

const TABS = ["prolog", "metadata", "data", "epilog"] as const;
type Tab = (typeof TABS)[number];

const CUBE_ARG1_FNS =
  "CellGetN|CellGetS|CellIsUpdateable|CubeExists|ViewExists|ViewCreate|ViewDestroy|ViewZeroOut|CubeClearData|SubsetCreatebyMDX|ViewSubsetAssign|DBR|DBS|DBSS|CubeProcessFeeders|CubeUnload|CubeLockOverride|CubeSetLogChanges";

const DIM_ARG1_FNS =
  "DimensionExists|HierarchyExists|SubsetExists|SubsetCreate|SubsetDestroy|DimensionElementInsertDirect|DimensionElementComponentAdd|DimensionElementDelete|DimensionElementPrincipalName|DimSiz|DimNm|DimIx|DType|ElementType|ElementLevel|ElementWeight|HierarchyName|AttrS|AttrN";

const CUBE_FN_RE = new RegExp(`\\b(${CUBE_ARG1_FNS})\\s*\\(\\s*'([^']+)'`, "gi");
const DIM_FN_RE = new RegExp(`\\b(${DIM_ARG1_FNS})\\s*\\(\\s*'([^']+)'`, "gi");

// Arg-1 passed as a bare identifier (sCube = 'x'; CellGetN(sCube, ...)) —
// resolved through the per-process variable env; unresolvable identifiers
// (params, datasource vars, reassigned or computed values) are skipped.
const CUBE_FN_IDENT_RE = new RegExp(`\\b(${CUBE_ARG1_FNS})\\s*\\(\\s*([A-Za-z_]\\w*)\\s*[,)]`, "gi");
const DIM_FN_IDENT_RE = new RegExp(`\\b(${DIM_ARG1_FNS})\\s*\\(\\s*([A-Za-z_]\\w*)\\s*[,)]`, "gi");

// CellPutN/CellPutS/CellIncrementN/CellPutProportionalSpread take the value as
// arg 1 and the cube as arg 2; AttrPutS/AttrPutN/ElementSecurityPut take the
// dimension as arg 2. The value arg is an arbitrary expression (nested calls,
// '|'-concat, multi-line), so these are resolved with a paren/quote walker
// (secondArgText) instead of a regex skip.
const CUBE_ARG2_FN_RE = /\b(?:CellPutN|CellPutS|CellIncrementN|CellPutProportionalSpread)\s*\(/gi;

const DIM_ARG2_FN_RE = /\b(?:AttrPutS|AttrPutN|ElementSecurityPut)\s*\(/gi;

// Cap the argument walk so a pathological unterminated call cannot scan the
// whole remaining tab.
const ARG_SCAN_MAX_CHARS = 2000;

// Walk the argument list starting after `(` at openParen, tracking paren depth
// and TI string state ('' is the quote escape), and return the raw text of the
// second top-level argument. Newlines are ordinary whitespace, so multi-line
// calls resolve too; TI strings cannot span lines, so an open string is closed
// at end-of-line to resync.
function secondArgText(text: string, openParen: number): string | null {
  let depth = 0;
  let inStr = false;
  let argIndex = 0;
  let argStart = openParen + 1;
  const end = Math.min(text.length, openParen + 1 + ARG_SCAN_MAX_CHARS);
  for (let i = openParen + 1; i < end; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          i++;
          continue;
        }
        inStr = false;
      } else if (ch === "\n") {
        inStr = false;
      }
      continue;
    }
    if (ch === "'") {
      inStr = true;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      if (depth === 0) {
        return argIndex === 1 ? text.slice(argStart, i) : null;
      }
      depth--;
    } else if (ch === "," && depth === 0) {
      if (argIndex === 1) return text.slice(argStart, i);
      argIndex++;
      argStart = i + 1;
    }
  }
  return null;
}

function quotedLiteral(argText: string): string | null {
  const m = /^\s*'((?:[^']|'')+)'\s*$/.exec(argText);
  return m ? m[1]!.replace(/''/g, "'") : null;
}

// Resolve a bare identifier through the process env: only a variable bound to
// exactly one string literal counts; params, datasource vars, and dynamic
// bindings return null (unresolvable at parse time).
function identLiteral(argText: string, env: ProcessEnv): string | null {
  const m = /^\s*([A-Za-z_]\w*)\s*$/.exec(argText);
  if (!m) return null;
  const binding = env.vars.get(m[1]!.toLowerCase());
  return binding?.kind === "literal" ? binding.value : null;
}

function scanCode(
  code: string,
  tab: Tab,
  regex: RegExp,
  resolveName?: (raw: string) => string | null,
): Map<string, { tab: Tab; line: number; context: string }> {
  const found = new Map<string, { tab: Tab; line: number; context: string }>();
  const lines = code.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    if (/^\s*#/.test(ln)) continue;
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(ln)) !== null) {
      const name = resolveName ? resolveName(m[2]!) : m[2]!;
      if (name && !found.has(name)) {
        found.set(name, { tab, line: i + 1, context: ln.trim().slice(0, 200) });
      }
    }
  }
  return found;
}

// Arg-2 variant of scanCode: matches the function name across the whole tab
// (comment lines blanked, so multi-line calls survive) and resolves the second
// argument with the paren/quote walker.
function scanArg2(
  code: string,
  tab: Tab,
  fnRe: RegExp,
  env: ProcessEnv,
): Map<string, { tab: Tab; line: number; context: string }> {
  const found = new Map<string, { tab: Tab; line: number; context: string }>();
  const lines = code.split(/\r?\n/).map((ln) => (/^\s*#/.test(ln) ? "" : ln));
  const text = lines.join("\n");
  fnRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(text)) !== null) {
    // The pattern ends with '(' — its index is the end of the match.
    const argText = secondArgText(text, m.index + m[0].length - 1);
    if (argText === null) continue;
    const name = quotedLiteral(argText) ?? identLiteral(argText, env);
    if (!name || found.has(name)) continue;
    const line = text.slice(0, m.index).split("\n").length;
    found.set(name, { tab, line, context: lines[line - 1]!.trim().slice(0, 200) });
  }
  return found;
}

export function registerValidateProcessRefs(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_validate_process_refs",
    "Scan a TI process (live, by name, or from .pro) for cube/dimension references in well-known TI functions (CellGetN/S, CellPutN/S, ViewCreate, DimensionElementInsertDirect, AttrPutS, etc.) and verify each name resolves on the server. TM1 lets syntactically valid code reference non-existent objects — this catches the gap between compile and runtime.",
    {
      processName: z.string().optional().describe("Validate an installed process by name"),
      filePath: z.string().optional().describe("Validate a .pro file (absolute host path). Disabled unless TM1_LOCAL_FILE_ROOT is set; the path must resolve within that directory. Otherwise pass 'content' inline."),
      content: z.string().optional().describe("Validate raw .pro content"),
      includeControl: z.boolean().optional().default(true).describe("Include control objects ('}'-prefixed) as valid targets. Default true."),
    },
    async ({ processName, filePath, content, includeControl }) => {
      if (!processName && !filePath && !content) {
        throw new TM1Error({
          code: TM1ErrorCode.VALIDATION_ERROR,
          message: "Provide processName, filePath, or content",
        });
      }

      let code: { prolog: string; metadata: string; data: string; epilog: string };
      let resolvedName = processName ?? "";
      if (processName) {
        code = await tm1Client.processes.getCode(processName);
      } else {
        let body = content ?? "";
        if (!body && filePath) {
          body = await fs.readFile(resolveLocalPath(filePath), "utf8");
        }
        const parsed = parseProFile(body);
        code = {
          prolog: parsed.prolog,
          metadata: parsed.metadata,
          data: parsed.data,
          epilog: parsed.epilog,
        };
        resolvedName = parsed.name ?? "(from-file)";
      }

      // Variable env across all tabs in runtime order: a prolog assignment
      // like sCube = 'Sales'; makes CellGetN(sCube, ...) resolvable. Params
      // are unknown here (only code is fetched), so param-fed identifiers
      // stay unresolvable — conservative.
      const env = buildProcessEnv(TABS.map((t) => code[t]).join("\n"), []);
      const resolveIdent = (raw: string) => identLiteral(raw, env);

      const cubeRefs = new Map<string, { tab: Tab; line: number; context: string }>();
      const dimRefs = new Map<string, { tab: Tab; line: number; context: string }>();
      for (const tab of TABS) {
        const c = code[tab];
        if (!c) continue;
        for (const [name, info] of scanCode(c, tab, CUBE_FN_RE)) {
          if (!cubeRefs.has(name)) cubeRefs.set(name, info);
        }
        for (const [name, info] of scanCode(c, tab, CUBE_FN_IDENT_RE, resolveIdent)) {
          if (!cubeRefs.has(name)) cubeRefs.set(name, info);
        }
        for (const [name, info] of scanArg2(c, tab, CUBE_ARG2_FN_RE, env)) {
          if (!cubeRefs.has(name)) cubeRefs.set(name, info);
        }
        for (const [name, info] of scanCode(c, tab, DIM_FN_RE)) {
          if (!dimRefs.has(name)) dimRefs.set(name, info);
        }
        for (const [name, info] of scanCode(c, tab, DIM_FN_IDENT_RE, resolveIdent)) {
          if (!dimRefs.has(name)) dimRefs.set(name, info);
        }
        for (const [name, info] of scanArg2(c, tab, DIM_ARG2_FN_RE, env)) {
          if (!dimRefs.has(name)) dimRefs.set(name, info);
        }
      }

      const [cubes, dims] = await Promise.all([tm1Client.cubes.list(), tm1Client.dimensions.list()]);
      const cubeNames = new Set(
        cubes.filter((c) => includeControl || !c.name.startsWith("}")).map((c) => c.name.toLowerCase()),
      );
      const dimNames = new Set(
        dims.filter((d) => includeControl || !d.name.startsWith("}")).map((d) => d.name.toLowerCase()),
      );

      const issues: RefIssue[] = [];
      for (const [name, info] of cubeRefs) {
        if (!cubeNames.has(name.toLowerCase())) {
          issues.push({ kind: "cube", name, ...info });
        }
      }
      for (const [name, info] of dimRefs) {
        if (!dimNames.has(name.toLowerCase())) {
          issues.push({ kind: "dimension", name, ...info });
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                processName: resolvedName,
                cubeRefsScanned: cubeRefs.size,
                dimensionRefsScanned: dimRefs.size,
                unresolved: issues.length,
                issues,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
