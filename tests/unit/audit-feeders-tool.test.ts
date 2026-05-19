import { describe, it, expect } from "vitest";
import { z, type ZodRawShape } from "zod";
import { registerAuditFeeders } from "../../src/tools/analysis/audit-feeders.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function makeFakeServer() {
  let captured: ToolHandler | null = null;
  let toolName = "";
  let parser: z.ZodObject<ZodRawShape> | null = null;
  const server = {
    tool: (
      name: string,
      _desc: string,
      schema: ZodRawShape,
      handler: ToolHandler,
    ) => {
      toolName = name;
      parser = z.object(schema);
      captured = handler;
    },
  };
  return {
    server: server as unknown as Parameters<typeof registerAuditFeeders>[0],
    getHandler: (): ToolHandler => {
      if (!captured || !parser) throw new Error("handler not registered");
      const p = parser;
      const h = captured;
      return (args) => h(p.parse(args) as Record<string, unknown>);
    },
    getName: () => toolName,
  };
}

interface FakeArgs {
  productVersion: string;
  rules?: Array<{ cubeName: string; rulesText: string; skipCheck: boolean }>;
  /** Map of cubeName -> ordered dimension names. Missing entry => getDimensionNames throws. */
  dims?: Record<string, string[]>;
  /** Map of "dim|hierarchy" -> { elemName: type } for the element-type cache. */
  elements?: Record<string, Record<string, "Numeric" | "Consolidated" | "String">>;
  /** Map of cubeName -> }StatsByCube measure values (drives runtime mode). Throws on miss. */
  cubeStats?: Record<string, Record<string, number>>;
}

function makeFakeTM1Client(args: FakeArgs) {
  const isControl = (n: string) => n.startsWith("}");
  return {
    server: { getInfo: async () => ({ productVersion: args.productVersion }) },
    cubes: {
      getAllRules: async (includeControl = false) => {
        const all = args.rules ?? [];
        return includeControl ? all : all.filter((r) => !isControl(r.cubeName));
      },
      getDimensionNames: async (cubeName: string) => {
        const dims = args.dims?.[cubeName];
        if (!dims) throw new Error(`no dims for ${cubeName}`);
        return dims;
      },
    },
    hierarchies: {
      get: async (dim: string, hier: string) => {
        const key = `${dim}|${hier}`;
        const elems = args.elements?.[key] ?? {};
        return {
          name: hier,
          dimensionName: dim,
          elements: Object.entries(elems).map(([name, type]) => ({
            name,
            type,
            level: 0,
            parents: [],
            children: [],
          })),
        };
      },
    },
    cells: {
      executeMdx: async (mdx: string) => {
        // Extract cube name from `{[}PerfCubes].[}PerfCubes].[<name>]}`.
        const m = mdx.match(/\.\[}PerfCubes]\.\[([^\]]+)]/);
        if (!m) throw new Error(`fake executeMdx: cannot parse cube from MDX`);
        const cubeName = m[1]!;
        const stats = args.cubeStats?.[cubeName];
        if (!stats) throw new Error(`fake executeMdx: }StatsByCube unavailable for ${cubeName}`);
        const entries = Object.entries(stats);
        return {
          axes: [
            { tuples: [] },
            {
              tuples: entries.map(([name]) => ({
                members: [{ name }],
              })),
            },
          ],
          cells: entries.map(([, v]) => ({ value: v })),
        };
      },
    },
  } as unknown as Parameters<typeof registerAuditFeeders>[1];
}

function parseResult(raw: unknown) {
  const result = raw as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text);
}

describe("tm1_audit_feeders tool", () => {
  it("registers under the expected name", () => {
    const fake = makeFakeServer();
    registerAuditFeeders(fake.server, makeFakeTM1Client({ productVersion: "11.8" }));
    expect(fake.getName()).toBe("tm1_audit_feeders");
  });

  it("returns pass when no cubes have feeders", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      rules: [{ cubeName: "Plain", rulesText: "skipcheck;\n['A']=N:1;", skipCheck: true }],
    });
    registerAuditFeeders(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({}));
    expect(out.status).toBe("pass");
    expect(out.scanned.cubes).toBe(1);
    expect(out.scanned.feederLines).toBe(0);
    expect(out.invalidCount).toBe(0);
  });

  it("degrades S1 gracefully when cube dim-order resolver fails (zero S1 findings)", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      rules: [
        {
          cubeName: "Sales",
          rulesText: [
            "skipcheck;",
            "['A','B','C','D','E'] = N: 1;",
            "feeders;",
            "['A','B'] => ['E'];",
          ].join("\n"),
          skipCheck: true,
        },
      ],
    });
    registerAuditFeeders(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({}));
    expect(out.summary.byRule.feeder_broader_than_rule).toBe(0);
    expect(out.scanned.dimResolveFailures).toBe(1);
    expect(out.status).toBe("pass");
  });

  it("flags feeder_broader_than_rule (S1) when cube has more dims than feeder pins", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      dims: { Sales: ["D1", "D2", "D3", "D4", "D5"] },
      rules: [
        {
          cubeName: "Sales",
          rulesText: [
            "skipcheck;",
            "['A','B','C','D','E'] = N: 1;",
            "feeders;",
            "['A','B'] => ['E'];",
          ].join("\n"),
          skipCheck: true,
        },
      ],
    });
    registerAuditFeeders(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({}));
    expect(out.summary.byRule.feeder_broader_than_rule).toBe(1);
    expect(out.findings[0].rule).toBe("feeder_broader_than_rule");
    expect(out.findings[0].detail).toBe("pins 2/5 dims");
  });

  it("flags db_feeder_without_skipcheck (S5) on DB() target lacking skipcheck", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      rules: [
        {
          cubeName: "Source",
          rulesText: [
            "skipcheck;",
            "['A'] = N: 1;",
            "feeders;",
            "['A'] => DB('Target', 'X', 'Y');",
          ].join("\n"),
          skipCheck: true,
        },
        {
          cubeName: "Target",
          rulesText: "['X','Y'] = N: 1;",
          skipCheck: false,
        },
      ],
    });
    registerAuditFeeders(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({}));
    expect(out.summary.byRule.db_feeder_without_skipcheck).toBe(1);
    const f = out.findings.find(
      (x: { rule: string }) => x.rule === "db_feeder_without_skipcheck",
    );
    expect(f.detail).toBe("Target");
  });

  it("does not flag db_feeder_without_skipcheck when target has skipcheck", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      rules: [
        {
          cubeName: "Source",
          rulesText: [
            "skipcheck;",
            "['A'] = N: 1;",
            "feeders;",
            "['A'] => DB('Target', 'X', 'Y');",
          ].join("\n"),
          skipCheck: true,
        },
        {
          cubeName: "Target",
          rulesText: "skipcheck;\n['X','Y'] = N: 1;",
          skipCheck: true,
        },
      ],
    });
    registerAuditFeeders(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({}));
    expect(out.summary.byRule.db_feeder_without_skipcheck).toBe(0);
  });

  it("flags missing_conditional_feeder (S3) when rule has STET but feeder has no IF guard", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      dims: { Sales: ["Region", "Time"] },
      rules: [
        {
          cubeName: "Sales",
          rulesText: [
            "skipcheck;",
            "['DE','2026'] = N: IF(1=1, STET, 0);",
            "feeders;",
            "['DE','2026'] => ['DE','2026'];",
          ].join("\n"),
          skipCheck: true,
        },
      ],
    });
    registerAuditFeeders(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({}));
    expect(out.summary.byRule.missing_conditional_feeder).toBe(1);
    expect(out.findings[0].rule).toBe("missing_conditional_feeder");
  });

  it("does not flag missing_conditional_feeder when feeder line has IF guard", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      dims: { Sales: ["Region", "Time"] },
      rules: [
        {
          cubeName: "Sales",
          rulesText: [
            "skipcheck;",
            "['DE','2026'] = N: IF(1=1, STET, 0);",
            "feeders;",
            "IF(1=1, ['DE','2026'] => ['DE','2026'], 0);",
          ].join("\n"),
          skipCheck: true,
        },
      ],
    });
    registerAuditFeeders(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({}));
    expect(out.summary.byRule.missing_conditional_feeder).toBe(0);
  });

  it("flags feeder_to_consolidated (S2) on consolidated LHS element", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      dims: { Sales: ["Region"] },
      elements: {
        "Region|Region": { Total: "Consolidated", DE: "Numeric" },
      },
      rules: [
        {
          cubeName: "Sales",
          rulesText: [
            "skipcheck;",
            "['DE'] = N: 1;",
            "feeders;",
            "['Total'] => ['DE'];",
          ].join("\n"),
          skipCheck: true,
        },
      ],
    });
    registerAuditFeeders(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({}));
    expect(out.summary.byRule.feeder_to_consolidated).toBe(1);
    expect(out.findings[0].rule).toBe("feeder_to_consolidated");
    expect(out.findings[0].detail).toBe("Region:Total");
  });

  it("flags orphan feeders whose elements don't appear in any rule (S6)", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      rules: [
        {
          cubeName: "Orphany",
          rulesText: [
            "skipcheck;",
            "['Real','Used'] = N: 1;",
            "feeders;",
            "['Ghost1','Ghost2'] => ['Ghost3'];",
          ].join("\n"),
          skipCheck: true,
        },
      ],
    });
    registerAuditFeeders(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({}));
    expect(out.summary.byRule.orphan_feeder).toBe(1);
    expect(out.findings[0].rule).toBe("orphan_feeder");
  });

  it("flags wildcard brackets (S4)", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      rules: [
        {
          cubeName: "Wild",
          rulesText: [
            "skipcheck;",
            "['A','B'] = N: 1;",
            "feeders;",
            "[] => ['B'];",
          ].join("\n"),
          skipCheck: true,
        },
      ],
    });
    registerAuditFeeders(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({}));
    expect(out.summary.byRule.wildcard_bracket).toBe(1);
  });

  it("excludes control objects by default and includes them on opt-in", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      rules: [
        {
          cubeName: "}Hidden",
          rulesText: ["skipcheck;", "['A','B'] = N: 1;", "feeders;", "['A'] => ['B'];"].join(
            "\n",
          ),
          skipCheck: true,
        },
      ],
    });
    registerAuditFeeders(fake.server, tm1);
    const handler = fake.getHandler();
    const defaultOut = parseResult(await handler({}));
    expect(defaultOut.scanned.cubes).toBe(0);

    const withControl = parseResult(await handler({ includeControl: true }));
    expect(withControl.scanned.cubes).toBe(1);
  });

  it("respects the cubes whitelist filter", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      rules: [
        {
          cubeName: "WantThis",
          rulesText: "skipcheck;\n['A','B']=N:1;\nfeeders;\n['A']=>['B'];",
          skipCheck: true,
        },
        {
          cubeName: "SkipThis",
          rulesText: "skipcheck;\n['A','B']=N:1;\nfeeders;\n[]=>['B'];",
          skipCheck: true,
        },
      ],
    });
    registerAuditFeeders(fake.server, tm1);
    const out = parseResult(
      await fake.getHandler()({ cubes: ["WantThis"] }),
    );
    expect(out.scanned.cubes).toBe(1);
    expect(out.findings.every((f: { cube: string }) => f.cube === "WantThis")).toBe(true);
  });

  it("honours topN cap and reports truncation", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      rules: [
        {
          cubeName: "Big",
          rulesText: [
            "skipcheck;",
            "['A','B','C','D'] = N: 1;",
            "feeders;",
            ...Array.from({ length: 6 }, () => "[] => ['D'];"),
          ].join("\n"),
          skipCheck: true,
        },
      ],
    });
    registerAuditFeeders(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({ topN: 3 }));
    expect(out.invalidCount).toBe(6);
    expect(out.findings).toHaveLength(3);
    expect(out.truncated.findings).toBe(true);
  });

  it("skips `=> [...]` continuation lines (multi-line feeder)", async () => {
    // Real-world cubes split a feeder across two lines; the second starts
    // with `=>`. The continuation must not be counted as a separate feeder.
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      rules: [
        {
          cubeName: "MultiLine",
          rulesText: [
            "skipcheck;",
            "['A','B','C'] = N: 1;",
            "feeders;",
            "[]",
            "=> ['C'];",
          ].join("\n"),
          skipCheck: true,
        },
      ],
    });
    registerAuditFeeders(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({}));
    // One feeder logically (wildcard LHS line). Continuation line filtered out.
    expect(out.scanned.feederLines).toBe(1);
    expect(out.invalidCount).toBe(1);
    expect(out.findings[0].rule).toBe("wildcard_bracket");
  });

  it("runtime mode flags cube_low_sparsity when populated/fed under threshold", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      rules: [
        {
          cubeName: "Sparse",
          rulesText: "skipcheck;\n['A']=N:1;\nfeeders;\n['A']=>['B'];",
          skipCheck: true,
        },
      ],
      cubeStats: {
        Sparse: {
          "Total Memory Used": 1_000_000,
          "Number of Populated Numeric Cells": 5,
          "Number of Fed Cells": 100_000,
        },
      },
    });
    registerAuditFeeders(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({ mode: "runtime" }));
    expect(out.summary.byRule.cube_low_sparsity).toBe(1);
    const ev = out.findings.find((f: { rule: string }) => f.rule === "cube_low_sparsity");
    expect(ev.severity).toBe("evidence");
    expect(out.runtimeStats.Sparse.sparsity).toBeLessThan(0.01);
  });

  it("runtime mode flags cube_high_memory above threshold", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      rules: [
        {
          cubeName: "Heavy",
          rulesText: "skipcheck;\n['A']=N:1;\nfeeders;\n['A']=>['B'];",
          skipCheck: true,
        },
      ],
      cubeStats: {
        Heavy: {
          "Total Memory Used": 2 * 1024 * 1024 * 1024, // 2 GiB
          "Number of Populated Numeric Cells": 100,
          "Number of Fed Cells": 100,
        },
      },
    });
    registerAuditFeeders(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({ mode: "runtime" }));
    expect(out.summary.byRule.cube_high_memory).toBe(1);
    expect(out.runtimeStats.Heavy.memoryMb).toBeGreaterThan(1024);
  });

  it("mode both escalates static findings on cubes with runtime evidence", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      rules: [
        {
          cubeName: "Wild",
          rulesText: ["skipcheck;", "['A','B'] = N: 1;", "feeders;", "[] => ['B'];"].join("\n"),
          skipCheck: true,
        },
      ],
      cubeStats: {
        Wild: {
          "Total Memory Used": 1_000_000,
          "Number of Populated Numeric Cells": 1,
          "Number of Fed Cells": 1_000_000,
        },
      },
    });
    registerAuditFeeders(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({ mode: "both" }));
    // Wildcard finding plus cube_low_sparsity. Both severity = evidence.
    const wildcard = out.findings.find((f: { rule: string }) => f.rule === "wildcard_bracket");
    expect(wildcard.severity).toBe("evidence");
    expect(out.summary.bySeverity.evidence).toBeGreaterThanOrEqual(2);
  });

  it("runtime mode degrades gracefully when }StatsByCube fetch fails", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      rules: [
        {
          cubeName: "NoStats",
          rulesText: "skipcheck;\n['A']=N:1;\nfeeders;\n['A']=>['B'];",
          skipCheck: true,
        },
      ],
      // cubeStats intentionally omitted → executeMdx throws.
    });
    registerAuditFeeders(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({ mode: "runtime" }));
    expect(out.scanned.runtimeFailures).toBe(1);
    expect(out.runtimeStats.NoStats.available).toBe(false);
    expect(out.summary.byRule.cube_low_sparsity).toBe(0);
    expect(out.summary.byRule.cube_high_memory).toBe(0);
  });

  it("default mode static does not call }StatsByCube", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      rules: [
        {
          cubeName: "Plain",
          rulesText: "skipcheck;\n['A']=N:1;\nfeeders;\n['A']=>['B'];",
          skipCheck: true,
        },
      ],
      // No cubeStats: would throw if called.
    });
    registerAuditFeeders(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({}));
    expect(out.mode).toBe("static");
    expect(out.runtimeStats).toBeUndefined();
  });

  it("uses positional element bag for orphan detection (real feeder style)", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      rules: [
        {
          cubeName: "Posi",
          rulesText: [
            "skipcheck;",
            "['Wert','DS_000','Alpha'] = N: 1;",
            "feeders;",
            "['Alpha_Entry', 'Wert', 'DS_000'] => ['Alpha'];",
          ].join("\n"),
          skipCheck: true,
        },
      ],
    });
    registerAuditFeeders(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({}));
    expect(out.summary.byRule.orphan_feeder).toBe(0);
  });
});
