import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import type { ProcessParameter, ProcessVariable, DataSource } from "../../types.js";
import { maskCode } from "../../lib/mask-secrets.js";

// ── LCS line diff ─────────────────────────────────────────────────────────────

type EditOp = { op: "eq" | "add" | "del"; line: string };

function computeEditScript(a: string[], b: string[]): EditOp[] {
  const m = a.length;
  const n = b.length;
  const w = n + 1;
  const dp = new Uint32Array((m + 1) * w);

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i * w + j] = 1 + (dp[(i + 1) * w + (j + 1)] ?? 0);
      } else {
        const skipA = dp[(i + 1) * w + j] ?? 0;
        const skipB = dp[i * w + (j + 1)] ?? 0;
        dp[i * w + j] = skipA >= skipB ? skipA : skipB;
      }
    }
  }

  const ops: EditOp[] = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    const ai = a[i], bj = b[j];
    if (i < m && j < n && ai === bj) {
      ops.push({ op: "eq", line: ai! });
      i++; j++;
    } else if (i < m && (j >= n || (dp[(i + 1) * w + j] ?? 0) >= (dp[i * w + (j + 1)] ?? 0))) {
      ops.push({ op: "del", line: ai! });
      i++;
    } else {
      ops.push({ op: "add", line: bj! });
      j++;
    }
  }
  return ops;
}

interface DiffHunk {
  startA: number;
  countA: number;
  startB: number;
  countB: number;
  lines: Array<{ type: " " | "+" | "-"; text: string }>;
}

function buildHunks(ops: EditOp[], contextLines: number): DiffHunk[] {
  type Positioned = { op: "eq" | "add" | "del"; line: string; lineA: number; lineB: number };
  const pos: Positioned[] = [];
  let lA = 1, lB = 1;
  for (const op of ops) {
    pos.push({ ...op, lineA: lA, lineB: lB });
    if (op.op === "eq") { lA++; lB++; }
    else if (op.op === "del") { lA++; }
    else { lB++; }
  }

  const inHunk = new Set<number>();
  for (let i = 0; i < pos.length; i++) {
    if (pos[i]!.op !== "eq") {
      for (let k = Math.max(0, i - contextLines); k <= Math.min(pos.length - 1, i + contextLines); k++) {
        inHunk.add(k);
      }
    }
  }
  if (inHunk.size === 0) return [];

  const indices = [...inHunk].sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  let s = indices[0]!, p = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    if (indices[i]! > p + 1) { ranges.push([s, p]); s = indices[i]!; }
    p = indices[i]!;
  }
  ranges.push([s, p]);

  return ranges.map(([from, to]) => {
    const lines: DiffHunk["lines"] = [];
    let startA = -1, startB = -1, countA = 0, countB = 0;
    for (let i = from; i <= to; i++) {
      const px = pos[i]!;
      if (startA === -1) { startA = px.lineA; startB = px.lineB; }
      if (px.op === "eq") { lines.push({ type: " ", text: px.line }); countA++; countB++; }
      else if (px.op === "del") { lines.push({ type: "-", text: px.line }); countA++; }
      else { lines.push({ type: "+", text: px.line }); countB++; }
    }
    return { startA, countA, startB, countB, lines };
  });
}

const NORM = (s: string): string => s.replace(/\r\n/g, "\n").trimEnd();

function tabCodeDiff(
  codeA: string,
  codeB: string,
  contextLines: number,
): { identical: boolean; linesA: number; linesB: number; hunks: DiffHunk[] } {
  const na = NORM(codeA);
  const nb = NORM(codeB);
  if (na === nb) {
    const lc = na ? na.split("\n").length : 0;
    return { identical: true, linesA: lc, linesB: lc, hunks: [] };
  }
  const a = na ? na.split("\n") : [];
  const b = nb ? nb.split("\n") : [];
  const ops = computeEditScript(a, b);
  const hunks = buildHunks(ops, contextLines);
  return { identical: false, linesA: a.length, linesB: b.length, hunks };
}

// ── param / var / datasource diff ────────────────────────────────────────────

function diffParams(a: ProcessParameter[], b: ProcessParameter[]) {
  const ma = new Map(a.map((p) => [p.name, p]));
  const mb = new Map(b.map((p) => [p.name, p]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: Array<{ name: string; a: ProcessParameter; b: ProcessParameter }> = [];
  for (const [name, pb] of mb) {
    const pa = ma.get(name);
    if (!pa) { added.push(name); continue; }
    if (pa.type !== pb.type || String(pa.defaultValue ?? "") !== String(pb.defaultValue ?? "") || (pa.prompt ?? "") !== (pb.prompt ?? "")) {
      changed.push({ name, a: pa, b: pb });
    }
  }
  for (const name of ma.keys()) if (!mb.has(name)) removed.push(name);
  return { identical: added.length === 0 && removed.length === 0 && changed.length === 0, added, removed, changed };
}

function diffVars(a: ProcessVariable[], b: ProcessVariable[]) {
  const ma = new Map(a.map((v) => [v.name, v]));
  const mb = new Map(b.map((v) => [v.name, v]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: Array<{ name: string; a: ProcessVariable; b: ProcessVariable }> = [];
  for (const [name, vb] of mb) {
    const va = ma.get(name);
    if (!va) { added.push(name); continue; }
    if (va.type !== vb.type || va.position !== vb.position) changed.push({ name, a: va, b: vb });
  }
  for (const name of ma.keys()) if (!mb.has(name)) removed.push(name);
  return { identical: added.length === 0 && removed.length === 0 && changed.length === 0, added, removed, changed };
}

function diffDs(a: DataSource, b: DataSource) {
  const diffs: string[] = [];
  const fields: Array<keyof DataSource> = [
    "type", "dataSourceNameForServer", "dataSourceNameForClient",
    "asciiDelimiterChar", "asciiQuoteCharacter", "asciiDecimalSeparator",
    "asciiThousandSeparator", "asciiHeaderRecords", "view", "subset", "userName",
  ];
  for (const f of fields) {
    if ((a[f] ?? "") !== (b[f] ?? "")) diffs.push(`${String(f)}: ${JSON.stringify(a[f])} → ${JSON.stringify(b[f])}`);
  }
  return { identical: diffs.length === 0, differences: diffs };
}

// ── tool ──────────────────────────────────────────────────────────────────────

const ALL_TABS = ["prolog", "metadata", "data", "epilog"] as const;
type Tab = (typeof ALL_TABS)[number];

export function registerDiffProcesses(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_diff_processes",
    [
      "Compare two installed TI processes tab-by-tab (Prolog/Metadata/Data/Epilog).",
      "Returns per-tab identical flag, line counts, and unified diff hunks for changed tabs.",
      "Also diffs parameters, variables, and datasource.",
      "Analogue of tm1_diff_process_with_file but server-side — no .pro file needed.",
    ].join(" "),
    {
      processA: z.string().describe("First process name (case-sensitive)"),
      processB: z.string().describe("Second process name (case-sensitive)"),
      tabs: z
        .array(z.enum(["prolog", "metadata", "data", "epilog"]))
        .optional()
        .describe("Tabs to diff (default: all four)"),
      contextLines: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .default(3)
        .describe("Lines of context around each changed hunk (default 3, max 10)"),
      maskSecrets: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Redact credential literals on BOTH sides before diffing (so a cred present on only one side can't leak via the diff). " +
            "Masks the password arg of ODBCOpen() and quoted values assigned to credential-named identifiers (pPwd, sToken, …). " +
            "Default: true. Set false only when explicitly auditing credentials.",
        ),
    },
    async ({ processA, processB, tabs, contextLines, maskSecrets }) => {
      const diffTabs: readonly Tab[] = tabs && tabs.length > 0 ? tabs : ALL_TABS;
      const mask = maskSecrets ? maskCode : (s: string) => s;

      const [codeA, codeB, paramsA, paramsB, varsA, varsB, dsA, dsB] = await Promise.all([
        tm1Client.processes.getCode(processA),
        tm1Client.processes.getCode(processB),
        tm1Client.processes.getParameters(processA),
        tm1Client.processes.getParameters(processB),
        tm1Client.processes.getVariables(processA),
        tm1Client.processes.getVariables(processB),
        tm1Client.processes.getDataSource(processA),
        tm1Client.processes.getDataSource(processB),
      ]);

      const tabResults: Record<string, ReturnType<typeof tabCodeDiff>> = {};
      for (const tab of diffTabs) {
        tabResults[tab] = tabCodeDiff(mask(codeA[tab] ?? ""), mask(codeB[tab] ?? ""), contextLines);
      }

      const parameters = diffParams(paramsA, paramsB);
      const variables = diffVars(varsA, varsB);
      const dataSource = diffDs(dsA, dsB);

      const identical =
        Object.values(tabResults).every((t) => t.identical) &&
        parameters.identical &&
        variables.identical &&
        dataSource.identical;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { processA, processB, identical, tabs: tabResults, parameters, variables, dataSource },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
