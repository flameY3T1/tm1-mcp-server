import { promises as fs } from "node:fs";
import { resolveLocalPath } from "../local-file.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { parseProFile } from "../../lib/pro-parser.js";

interface RefIssue {
  kind: "cube" | "dimension";
  name: string;
  tab: "prolog" | "metadata" | "data" | "epilog";
  line: number;
  context: string;
}

const TABS = ["prolog", "metadata", "data", "epilog"] as const;
type Tab = (typeof TABS)[number];

const CUBE_FN_RE =
  /\b(CellGetN|CellGetS|CellIsUpdateable|CubeExists|ViewExists|ViewCreate|ViewDestroy|ViewZeroOut|CubeClearData|SubsetCreatebyMDX|ViewSubsetAssign|DBR|DBS|DBSS|CubeProcessFeeders|CubeUnload|CubeLockOverride|CubeSetLogChanges)\s*\(\s*'([^']+)'/gi;

// CellPutN/CellPutS/CellIncrementN/CellPutProportionalSpread take the value as
// arg 1 and the cube as arg 2. The value can be any expression (literal,
// identifier, '|'-concat) — skip to the first top-level comma. Nested calls in
// the value arg defeat the skip and the ref is silently missed (same
// limitation as DIM_AT_ARG2_RE below).
const CUBE_AT_ARG2_RE =
  /\b(CellPutN|CellPutS|CellIncrementN|CellPutProportionalSpread)\s*\(\s*(?:'(?:[^'\\]|\\.)*'|[^,()]+)(?:\s*\|\s*(?:'(?:[^'\\]|\\.)*'|[^,()]+))*\s*,\s*'([^']+)'/gi;

const DIM_FN_RE =
  /\b(DimensionExists|HierarchyExists|SubsetExists|SubsetCreate|SubsetDestroy|DimensionElementInsertDirect|DimensionElementComponentAdd|DimensionElementDelete|DimensionElementPrincipalName|DimSiz|DimNm|DimIx|DType|ElementType|ElementLevel|ElementWeight|HierarchyName|AttrS|AttrN)\s*\(\s*'([^']+)'/gi;

// AttrPutS/AttrPutN/ElementSecurityPut: value is arg 1, dimension is arg 2.
// The value can be a literal, identifier, or string-concat expression with '|' — skip over until first top-level comma.
const DIM_AT_ARG2_RE =
  /\b(AttrPutS|AttrPutN|ElementSecurityPut)\s*\(\s*(?:'(?:[^'\\]|\\.)*'|[^,()]+)(?:\s*\|\s*(?:'(?:[^'\\]|\\.)*'|[^,()]+))*\s*,\s*'([^']+)'/gi;

function scanCode(code: string, tab: Tab, regex: RegExp): Map<string, { tab: Tab; line: number; context: string }> {
  const found = new Map<string, { tab: Tab; line: number; context: string }>();
  const lines = code.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    if (/^\s*#/.test(ln)) continue;
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(ln)) !== null) {
      const name = m[2]!;
      if (!found.has(name)) {
        found.set(name, { tab, line: i + 1, context: ln.trim().slice(0, 200) });
      }
    }
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

      const cubeRefs = new Map<string, { tab: Tab; line: number; context: string }>();
      const dimRefs = new Map<string, { tab: Tab; line: number; context: string }>();
      for (const tab of TABS) {
        const c = code[tab];
        if (!c) continue;
        for (const [name, info] of scanCode(c, tab, CUBE_FN_RE)) {
          if (!cubeRefs.has(name)) cubeRefs.set(name, info);
        }
        for (const [name, info] of scanCode(c, tab, CUBE_AT_ARG2_RE)) {
          if (!cubeRefs.has(name)) cubeRefs.set(name, info);
        }
        for (const [name, info] of scanCode(c, tab, DIM_FN_RE)) {
          if (!dimRefs.has(name)) dimRefs.set(name, info);
        }
        for (const [name, info] of scanCode(c, tab, DIM_AT_ARG2_RE)) {
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
