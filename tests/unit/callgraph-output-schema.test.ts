import { describe, it, expect } from "vitest";
import { buildReferenceIndex, type ReferenceIndex, type CallParam } from "../../src/lib/callgraph/referenceIndex.js";
import { buildCallGraph, type CallGraphNode, type EffectiveValue } from "../../src/lib/callgraph/callGraph.js";
import { globalRanking } from "../../src/tools/analysis/analyze-callgraph.js";
import { CallgraphResultSchema } from "../../src/tools/schemas/items.js";
import { isSecretName, MASK, maskCodeLine } from "../../src/lib/mask-secrets.js";

// ─────────────────────────────────────────────────────────────────────────────
// The serializers (serializeNode / serializeCompact / summarize) live private
// inside src/tools/analysis/analyze-callgraph.ts. To keep the change to two
// files (schema + this test) and NOT touch handler code, they are mirrored
// VERBATIM below. If the real serializers change, this copy must change with
// them — the round-trip assertion is only as faithful as this mirror.
// (globalRanking IS exported and is used directly — no copy needed.)
// ─────────────────────────────────────────────────────────────────────────────

function maskParams(params: readonly CallParam[]): CallParam[] {
  return params.map((p) =>
    isSecretName(p.name)
      ? {
          ...p,
          valueRaw: MASK,
          resolution:
            p.resolution.kind === "literal" ? { kind: "literal" as const, value: MASK } : p.resolution,
        }
      : p,
  );
}

function maskEffective(
  eff: ReadonlyArray<{ name: string; effective: EffectiveValue; valueRaw: string }>,
): Array<{ name: string; effective: EffectiveValue; valueRaw: string }> {
  return eff.map((e) =>
    isSecretName(e.name)
      ? {
          ...e,
          valueRaw: MASK,
          effective: e.effective.kind === "literal" ? { kind: "literal" as const, value: MASK } : e.effective,
        }
      : e,
  );
}

function maskEnv(env: Map<string, EffectiveValue>): Record<string, EffectiveValue> {
  const out: Record<string, EffectiveValue> = {};
  for (const [k, v] of env.entries()) {
    out[k] = isSecretName(k) && v.kind === "literal" ? { kind: "literal", value: MASK } : v;
  }
  return out;
}

interface CompactNode {
  process: string;
  cycle?: boolean;
  depthLimitReached?: boolean;
  unresolvedCalls?: Array<{ section: string; line: number; funcName: string; expr: string; reason: string }>;
  children: CompactNode[];
}

function serializeCompact(node: CallGraphNode): CompactNode {
  const out: CompactNode = {
    process: node.process,
    children: node.children.map(serializeCompact),
  };
  if (node.cycle) out.cycle = true;
  if (node.depthLimitReached) out.depthLimitReached = true;
  if (node.unresolvedCalls && node.unresolvedCalls.length > 0) {
    out.unresolvedCalls = node.unresolvedCalls.map((u) => ({
      section: u.section,
      line: u.line,
      funcName: u.funcName,
      expr: u.expr,
      reason: u.reason,
    }));
  }
  return out;
}

function serializeNode(node: CallGraphNode, mask: boolean): unknown {
  return {
    process: node.process,
    cycle: node.cycle,
    depthLimitReached: node.depthLimitReached,
    incomingEdge: node.incomingEdge
      ? {
          caller: node.incomingEdge.caller,
          callee: node.incomingEdge.callee,
          section: node.incomingEdge.section,
          line: node.incomingEdge.line,
          funcName: node.incomingEdge.funcName,
          snippet: mask ? maskCodeLine(node.incomingEdge.snippet) : node.incomingEdge.snippet,
          params: mask ? maskParams(node.incomingEdge.params) : node.incomingEdge.params,
          effectiveParams: node.incomingEdge.effectiveParams
            ? mask
              ? maskEffective(node.incomingEdge.effectiveParams)
              : node.incomingEdge.effectiveParams
            : undefined,
        }
      : null,
    env: node.env ? (mask ? maskEnv(node.env) : Object.fromEntries(node.env.entries())) : undefined,
    unresolvedCalls: node.unresolvedCalls
      ? node.unresolvedCalls.map((u) => ({
          section: u.section,
          line: u.line,
          funcName: u.funcName,
          expr: u.expr,
          snippet: mask ? maskCodeLine(u.snippet) : u.snippet,
          reason: u.reason,
        }))
      : undefined,
    children: node.children.map((c) => serializeNode(c, mask)),
  };
}

interface SummaryEntry {
  process: string;
  depthMin: number;
  depthMax: number;
  occurrences: number;
  cycle: boolean;
  depthLimitReached: boolean;
  unresolvedCount: number;
}

function summarize(root: CallGraphNode): unknown {
  const map = new Map<string, SummaryEntry>();
  let totalNodes = 0;
  let maxDepth = 0;
  let cyclesDetected = 0;
  let depthLimitsHit = 0;

  function walk(node: CallGraphNode, depth: number): void {
    totalNodes++;
    if (depth > maxDepth) maxDepth = depth;
    const isCycle = !!node.cycle;
    const isDepthLimit = !!node.depthLimitReached;
    if (isCycle) cyclesDetected++;
    if (isDepthLimit) depthLimitsHit++;

    const existing = map.get(node.process);
    if (existing) {
      existing.occurrences++;
      if (depth < existing.depthMin) existing.depthMin = depth;
      if (depth > existing.depthMax) existing.depthMax = depth;
      existing.cycle = existing.cycle || isCycle;
      existing.depthLimitReached = existing.depthLimitReached || isDepthLimit;
    } else {
      map.set(node.process, {
        process: node.process,
        depthMin: depth,
        depthMax: depth,
        occurrences: 1,
        cycle: isCycle,
        depthLimitReached: isDepthLimit,
        unresolvedCount: node.unresolvedCalls?.length ?? 0,
      });
    }

    for (const child of node.children) walk(child, depth + 1);
  }

  walk(root, 0);

  const processes = Array.from(map.values()).sort((a, b) => {
    if (a.depthMin !== b.depthMin) return a.depthMin - b.depthMin;
    return b.occurrences - a.occurrences;
  });

  return {
    root: root.process,
    totalNodes,
    uniqueProcesses: map.size,
    maxDepth,
    cyclesDetected,
    depthLimitsHit,
    processes,
  };
}

// ─── Harness ─────────────────────────────────────────────────────────────────
// Parent → Child (resolved edge with literal + dynamic params, env propagation),
// Child → Parent (cycle), and Parent has a dynamic unresolvedCalls entry.
async function buildTestIndex(): Promise<ReferenceIndex> {
  return buildReferenceIndex({
    fetchProcesses: async () => [
      {
        name: "Parent",
        prolog:
          "ExecuteProcess('Child', 'pIn', 'UK', 'pDyn', NumberToString(1|2));\nsDyn = sOther;\nExecuteProcess(sDyn);",
        metadata: "",
        data: "",
        epilog: "",
        parameters: ["pRegion"],
      },
      {
        name: "Child",
        prolog: "ExecuteProcess('Parent');",
        metadata: "",
        data: "",
        epilog: "",
        parameters: ["pIn"],
      },
    ],
    fetchCubesWithRules: async () => [],
    fetchChores: async () => [],
  });
}

// Mirror the guard: it validates JSON.parse(JSON.stringify(payload)).
function roundTrip(payload: unknown): unknown {
  return JSON.parse(JSON.stringify(payload));
}

describe("CallgraphResultSchema — validates every emitted shape", () => {
  it("validates the full-tree payload (mode='full')", async () => {
    const index = await buildTestIndex();
    const tree = buildCallGraph(index, "Parent", { direction: "downstream" });
    const payload = { start: "Parent", direction: "downstream", mode: "full", maskSecrets: false, tree: serializeNode(tree, false) };
    const parsed = CallgraphResultSchema.safeParse(roundTrip(payload));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("validates the full-tree payload with masking on", async () => {
    const index = await buildTestIndex();
    const tree = buildCallGraph(index, "Parent", { direction: "downstream" });
    const payload = { start: "Parent", direction: "downstream", mode: "full", maskSecrets: true, tree: serializeNode(tree, true) };
    const parsed = CallgraphResultSchema.safeParse(roundTrip(payload));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("validates the compact-tree payload (mode='compact')", async () => {
    const index = await buildTestIndex();
    const tree = buildCallGraph(index, "Parent", { direction: "downstream" });
    const payload = { start: "Parent", direction: "downstream", mode: "compact", tree: serializeCompact(tree) };
    const parsed = CallgraphResultSchema.safeParse(roundTrip(payload));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("validates the upstream full-tree payload (no env)", async () => {
    const index = await buildTestIndex();
    const tree = buildCallGraph(index, "Child", { direction: "upstream" });
    const payload = { start: "Child", direction: "upstream", mode: "full", maskSecrets: false, tree: serializeNode(tree, false) };
    const parsed = CallgraphResultSchema.safeParse(roundTrip(payload));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("validates the summary payload (mode='summary')", async () => {
    const index = await buildTestIndex();
    const tree = buildCallGraph(index, "Parent", { direction: "downstream" });
    const payload = { start: "Parent", direction: "downstream", mode: "summary", maskSecrets: false, summary: summarize(tree) };
    const parsed = CallgraphResultSchema.safeParse(roundTrip(payload));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("validates the globalRanking payload (start omitted)", async () => {
    const index = await buildTestIndex();
    const result = globalRanking(index, { rankBy: "outgoing", topN: 50, includeSystem: false });
    const payload = { mode: "globalRanking", ...result };
    const parsed = CallgraphResultSchema.safeParse(roundTrip(payload));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("validates the warning payload (process not found)", async () => {
    const index = await buildTestIndex();
    const payload = { warning: `Process "Nope" not found in index.`, indexedProcessCount: index.processParams.size };
    const parsed = CallgraphResultSchema.safeParse(roundTrip(payload));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  // ─── Negative: the guard must now bite on a structurally-wrong tree ─────────
  it("REJECTS a structurally-wrong tree (children is a string)", async () => {
    const bad = {
      start: "Parent",
      direction: "downstream",
      mode: "full",
      maskSecrets: false,
      tree: { process: "Parent", cycle: false, incomingEdge: null, children: "not-an-array" },
    };
    expect(CallgraphResultSchema.safeParse(roundTrip(bad)).success).toBe(false);
  });

  it("REJECTS a tree node missing `process`", async () => {
    const bad = {
      start: "Parent",
      direction: "downstream",
      mode: "full",
      tree: { cycle: false, incomingEdge: null, children: [] },
    };
    expect(CallgraphResultSchema.safeParse(roundTrip(bad)).success).toBe(false);
  });

  // ─── Strictness is NOT traded away for wire size ────────────────────────────
  // The `Int` / `EffectiveValue` sub-schemas are emitted as `$ref`s to shrink
  // the published schema. `$ref` is a serialization detail only — these assert
  // the Zod-side checks still bite exactly as they did when inlined.
  it("REJECTS a non-integer count (shared Int schema keeps .int())", () => {
    const bad = {
      mode: "summary",
      summary: {
        root: "Parent",
        totalNodes: 2.5,
        uniqueProcesses: 2,
        maxDepth: 1,
        cyclesDetected: 0,
        depthLimitsHit: 0,
        processes: [],
      },
    };
    expect(CallgraphResultSchema.safeParse(bad).success).toBe(false);
  });

  it("REJECTS a non-integer ranking entry", () => {
    const bad = {
      mode: "globalRanking",
      ranking: [
        {
          process: "Parent",
          outgoingCalls: 1.5,
          outgoingDistinct: 1,
          incomingCalls: 0,
          incomingDistinct: 0,
        },
      ],
    };
    expect(CallgraphResultSchema.safeParse(bad).success).toBe(false);
  });

  it("REJECTS a non-integer summary entry depth", () => {
    const bad = {
      mode: "summary",
      summary: {
        root: "Parent",
        totalNodes: 2,
        uniqueProcesses: 1,
        maxDepth: 0,
        cyclesDetected: 0,
        depthLimitsHit: 0,
        processes: [
          {
            process: "Parent",
            depthMin: 0.5,
            depthMax: 1,
            occurrences: 1,
            cycle: false,
            depthLimitReached: false,
            unresolvedCount: 0,
          },
        ],
      },
    };
    expect(CallgraphResultSchema.safeParse(bad).success).toBe(false);
  });

  it("REJECTS a wrongly-typed node field that both tree shapes declare", () => {
    const bad = {
      mode: "full",
      tree: { process: "Parent", cycle: "yes", incomingEdge: null, children: [] },
    };
    expect(CallgraphResultSchema.safeParse(bad).success).toBe(false);
  });

  // `tree` is a union of FullNode | CompactNode. A non-strict Zod object STRIPS
  // unknown keys rather than rejecting them, which used to let a corrupt
  // full-mode node slip through by matching the compact variant with the corrupt
  // keys thrown away — the FullNode detail was client documentation, not a
  // guard. Both variants are `.strict()` now; these four cases are the ones that
  // were silently accepted before.
  it.each([
    [
      "a stray key on a compact-shaped node",
      { mode: "compact", tree: { process: "P", children: [], bogus: 1 } },
    ],
    [
      "a stray key nested in children",
      { mode: "compact", tree: { process: "P", children: [{ process: "C", children: [], junk: true }] } },
    ],
    [
      "a corrupt env value kind",
      {
        mode: "full",
        tree: { process: "P", cycle: false, incomingEdge: null, env: { v: { kind: "nope" } }, children: [] },
      },
    ],
    [
      "a non-numeric incomingEdge line",
      {
        mode: "full",
        tree: {
          process: "P",
          cycle: false,
          incomingEdge: {
            caller: "a",
            callee: "b",
            section: "s",
            line: "NOT-A-NUMBER",
            funcName: "f",
            snippet: "x",
            params: [],
          },
          children: [],
        },
      },
    ],
  ])("REJECTS %s instead of stripping it into the other union variant", (_label, bad) => {
    expect(CallgraphResultSchema.safeParse(bad).success).toBe(false);
  });

  it("still ACCEPTS well-formed nodes in both modes", () => {
    const full = {
      mode: "full",
      tree: { process: "P", cycle: false, depthLimitReached: false, incomingEdge: null, children: [] },
    };
    const compact = { mode: "compact", tree: { process: "P", children: [{ process: "C", children: [] }] } };
    expect(CallgraphResultSchema.safeParse(full).success).toBe(true);
    expect(CallgraphResultSchema.safeParse(compact).success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wire-size guard. This is the largest published outputSchema; every session
// pays for it in tools/list. It is serialized here EXACTLY as McpServer does
// (same SDK functions + options as scripts/check-output-schema-budget.mjs) and
// then put through the same `slimJsonSchema()` the tools/list handler applies,
// so the byte number below is the shipped number, not an approximation.
// ─────────────────────────────────────────────────────────────────────────────
describe("CallgraphResultSchema — serialized JSON Schema shape", () => {
  async function serialize(): Promise<Record<string, unknown>> {
    const { normalizeObjectSchema } = await import(
      "@modelcontextprotocol/sdk/server/zod-compat.js"
    );
    const { toJsonSchemaCompat } = await import(
      "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js"
    );
    const { slimJsonSchema } = await import("../../src/lib/slim-json-schema.js");
    const normalized = normalizeObjectSchema(CallgraphResultSchema);
    expect(normalized).toBeDefined();
    // Same options McpServer passes in setToolRequestHandlers.
    const raw = toJsonSchemaCompat(normalized!, { strictUnions: true, pipeStrategy: "output" });
    return slimJsonSchema(raw) as Record<string, unknown>;
  }

  it("factors repeated sub-schemas into `definitions` + `$ref`", async () => {
    const json = await serialize();
    const defs = json["definitions"] as Record<string, unknown> | undefined;
    expect(defs, "expected a definitions block").toBeDefined();
    // Named id (added deliberately) …
    expect(Object.keys(defs!)).toEqual(expect.arrayContaining(["EffectiveValue"]));
    // … alongside the auto-named recursive node defs that always shipped.
    expect(Object.keys(defs!).some((k) => k.startsWith("__schema"))).toBe(true);
    // Ints stay inlined ON PURPOSE: slimJsonSchema() strips their safe-integer
    // bounds, so an inline int is smaller than a $ref to a shared definition.
    expect(Object.keys(defs!)).not.toContain("Int");

    const wire = JSON.stringify(json);
    // Nothing on the wire may carry the safe-integer sentinels any more.
    expect(wire).not.toContain(`"minimum":-9007199254740991`);
    expect(wire).not.toContain(`"maximum":9007199254740991`);
    // EffectiveValue's body is emitted once; its two use sites (an edge's
    // effectiveParams[].effective and a node's env values) are both `$ref`s.
    expect(wire.split(`"const":"unknown"`).length - 1).toBe(1);
    expect(wire.split(`#/definitions/EffectiveValue`).length - 1).toBe(2);
    expect(wire).toContain(`{"$ref":"#/definitions/EffectiveValue"}`);
    // The union must keep all three variants — refs must not become a pretext
    // for collapsing EffectiveValue and CallParamResolution into one shape.
    const effective = defs!["EffectiveValue"] as { oneOf?: unknown[] };
    expect(effective.oneOf).toHaveLength(3);
  });

  it("stays inside its byte ceiling", async () => {
    const bytes = Buffer.byteLength(JSON.stringify(await serialize()), "utf8");
    // Was 6286 bytes (8% of the whole tools/list outputSchema payload) when
    // every reused sub-schema was inlined and the safe-integer sentinels still
    // shipped; `$ref` factoring plus slimJsonSchema() brought it to ~4770 with
    // zero validation loss. The ceiling leaves room for a genuine new field but
    // trips if the factoring is undone or a big block is added.
    expect(bytes, `serialized CallgraphResultSchema = ${bytes} bytes`).toBeLessThanOrEqual(5000);
  });
});
