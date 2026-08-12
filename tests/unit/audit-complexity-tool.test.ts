import { describe, it, expect } from "vitest";
import { z, type ZodRawShape } from "zod";
import { registerAuditComplexity } from "../../src/tools/analysis/audit-complexity.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function makeFakeServer() {
  let captured: ToolHandler | null = null;
  let toolName = "";
  let parser: z.ZodObject<ZodRawShape> | null = null;
  const server = {
    tool: (
      name: string,
      _d: string,
      schema: ZodRawShape,
      handler: ToolHandler,
    ) => {
      toolName = name;
      parser = z.object(schema);
      captured = handler;
    },
  };
  return {
    server: server as unknown as Parameters<typeof registerAuditComplexity>[0],
    getHandler: (): ToolHandler => {
      if (!captured || !parser) throw new Error("handler not registered");
      const p = parser;
      const h = captured;
      return (args) => h(p.parse(args));
    },
    getName: () => toolName,
  };
}

interface FakeArgs {
  productVersion: string;
  processes?: Array<{
    name: string;
    prolog: string;
    metadata: string;
    data: string;
    epilog: string;
  }>;
  variables?: Record<
    string,
    Array<{ name: string; type: "String" | "Numeric"; position: number }>
  >;
  rules?: Array<{ cubeName: string; rulesText: string; skipCheck: boolean }>;
  /** Overrides the bulk lookup so a test can instrument ordering/failures. */
  getAllVariablesImpl?: (
    includeControl: boolean,
  ) => Promise<
    Map<
      string,
      Array<{ name: string; type: "String" | "Numeric"; position: number }>
    >
  >;
}

function makeAuditComplexityClientStub(args: FakeArgs) {
  // Mirrors the real services, which apply $filter=not startswith(Name,'}')
  // server-side when includeControl=false.
  const isControl = (n: string) => n.startsWith("}");
  return {
    server: { getInfo: async () => ({ productVersion: args.productVersion }) },
    processes: {
      getAllCode: async (includeControl = false) => {
        const all = args.processes ?? [];
        return includeControl ? all : all.filter((p) => !isControl(p.name));
      },
      getAllVariables: async (includeControl = false) => {
        if (args.getAllVariablesImpl)
          return await args.getAllVariablesImpl(includeControl);
        const names = (args.processes ?? [])
          .map((p) => p.name)
          .filter((n) => includeControl || !isControl(n));
        return new Map(names.map((n) => [n, args.variables?.[n] ?? []]));
      },
    },
    cubes: {
      getAllRules: async (includeControl = false) => {
        const all = args.rules ?? [];
        return includeControl ? all : all.filter((r) => !isControl(r.cubeName));
      },
    },
  } as unknown as Parameters<typeof registerAuditComplexity>[1];
}

function parseResult(raw: unknown) {
  const result = raw as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text);
}

describe("tm1_audit_complexity tool", () => {
  it("registers under the expected name", () => {
    const fake = makeFakeServer();
    registerAuditComplexity(
      fake.server,
      makeAuditComplexityClientStub({ productVersion: "11.8" }),
    );
    expect(fake.getName()).toBe("tm1_audit_complexity");
  });

  it("returns pass when no objects exist", async () => {
    const fake = makeFakeServer();
    registerAuditComplexity(
      fake.server,
      makeAuditComplexityClientStub({ productVersion: "11.8" }),
    );
    const out = parseResult(await fake.getHandler()({}));
    expect(out.status).toBe("pass");
    expect(out.scanned.processes).toBe(0);
    expect(out.scanned.rules).toBe(0);
  });

  it("scans processes and reports topProcesses sorted by score", async () => {
    const fake = makeFakeServer();
    const tm1 = makeAuditComplexityClientStub({
      productVersion: "11.8",
      processes: [
        { name: "Trivial", prolog: "x=1;", metadata: "", data: "", epilog: "" },
        {
          name: "Complex",
          prolog: "IF(a=1);\n  WHILE(b<10);\n    c=1;\n  END;\nENDIF;",
          metadata: "",
          data: "",
          epilog: "",
        },
      ],
    });
    registerAuditComplexity(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({ scope: ["processes"] }));
    expect(out.scanned.processes).toBe(2);
    expect(out.topProcesses[0].name).toBe("Complex");
    expect(out.topProcesses[0].totals.maxNesting).toBe(2);
  });

  it("excludes control objects by default", async () => {
    const fake = makeFakeServer();
    const tm1 = makeAuditComplexityClientStub({
      productVersion: "11.8",
      processes: [
        {
          name: "}Stats_Process",
          prolog: "x=1;",
          metadata: "",
          data: "",
          epilog: "",
        },
        { name: "Real", prolog: "y=2;", metadata: "", data: "", epilog: "" },
      ],
    });
    registerAuditComplexity(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({ scope: ["processes"] }));
    expect(out.scanned.processes).toBe(1);
    expect(out.topProcesses[0].name).toBe("Real");
  });

  it("scans rules and lists cubes without skipcheck", async () => {
    const fake = makeFakeServer();
    const tm1 = makeAuditComplexityClientStub({
      productVersion: "11.8",
      rules: [
        {
          cubeName: "WithCheck",
          rulesText: "skipcheck;\n['A']=N:1;",
          skipCheck: true,
        },
        { cubeName: "NoCheck", rulesText: "['A']=N:1;", skipCheck: false },
      ],
    });
    registerAuditComplexity(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({ scope: ["rules"] }));
    expect(out.scanned.rules).toBe(2);
    expect(out.summary.rules.cubesWithoutSkipcheck).toEqual(["NoCheck"]);
  });

  it("detects cross-process variable variants and type conflicts", async () => {
    const fake = makeFakeServer();
    const tm1 = makeAuditComplexityClientStub({
      productVersion: "11.8",
      processes: [
        { name: "Load_Sales", prolog: "", metadata: "", data: "", epilog: "" },
        {
          name: "Aggregate_Sales",
          prolog: "",
          metadata: "",
          data: "",
          epilog: "",
        },
      ],
      variables: {
        Load_Sales: [
          { name: "pYear", type: "Numeric", position: 1 },
          { name: "pDate", type: "Numeric", position: 2 },
        ],
        Aggregate_Sales: [
          { name: "vYear", type: "Numeric", position: 1 },
          { name: "pDate", type: "String", position: 2 },
        ],
      },
    });
    registerAuditComplexity(fake.server, tm1);
    const out = parseResult(
      await fake.getHandler()({ scope: ["consistency"] }),
    );
    expect(out.consistency.variableClusters).toHaveLength(1);
    expect(out.consistency.variableClusters[0].normalized).toBe("year");
    expect(out.consistency.typeConflicts).toHaveLength(1);
    expect(out.consistency.typeConflicts[0].variable).toBe("pDate");
    expect(out.consistency.cohorts).toHaveLength(1);
    expect(out.consistency.cohorts[0].key).toBe("sales");
    expect(out.status).toBe("fail");
  });

  it("respects topN cap", async () => {
    const fake = makeFakeServer();
    const procs = Array.from({ length: 30 }, (_, i) => ({
      name: `P${i}`,
      prolog: `x=${i};`,
      metadata: "",
      data: "",
      epilog: "",
    }));
    const tm1 = makeAuditComplexityClientStub({
      productVersion: "11.8",
      processes: procs,
    });
    registerAuditComplexity(fake.server, tm1);
    const out = parseResult(
      await fake.getHandler()({ scope: ["processes"], topN: 5 }),
    );
    expect(out.scanned.processes).toBe(30);
    expect(out.topProcesses).toHaveLength(5);
    expect(out.truncated.processes).toBe(true);
  });

  it("status=pass when only trivial processes exist and no consistency issues", async () => {
    const fake = makeFakeServer();
    const tm1 = makeAuditComplexityClientStub({
      productVersion: "11.8",
      processes: [
        { name: "Tiny", prolog: "x=1;", metadata: "", data: "", epilog: "" },
      ],
    });
    registerAuditComplexity(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({ scope: ["processes"] }));
    expect(out.scanned.processes).toBe(1);
    expect(out.topProcesses).toHaveLength(1);
    expect(out.status).toBe("pass");
  });

  it("status=fail when scoreThreshold>0 is met by topProcesses", async () => {
    const fake = makeFakeServer();
    const tm1 = makeAuditComplexityClientStub({
      productVersion: "11.8",
      processes: [
        {
          name: "Big",
          prolog: "IF(a=1);\n  IF(b=1);\n    c=1;\n  ENDIF;\nENDIF;",
          metadata: "",
          data: "",
          epilog: "",
        },
      ],
    });
    registerAuditComplexity(fake.server, tm1);
    const out = parseResult(
      await fake.getHandler()({ scope: ["processes"], scoreThreshold: 5 }),
    );
    expect(out.topProcesses.length).toBeGreaterThan(0);
    expect(out.status).toBe("fail");
  });

  // FlatBig: 10 sibling IFs (branch-heavy, no loops) -> high v1, modest v2.
  // DeepLoop: 4 nested whiles -> modest v1, high v2 (loop nesting multiplies).
  const FLAT_BIG = Array.from(
    { length: 10 },
    () => "IF(x=1);\na=1;\nENDIF;",
  ).join("\n");
  const DEEP_LOOP =
    "WHILE(a<1);\nWHILE(b<1);\nWHILE(c<1);\nWHILE(d<1);\nx=1;\nEND;\nEND;\nEND;\nEND;";

  it("ranks by v1 score by default (branch-heavy process first)", async () => {
    const fake = makeFakeServer();
    const tm1 = makeAuditComplexityClientStub({
      productVersion: "11.8",
      processes: [
        {
          name: "DeepLoop",
          prolog: DEEP_LOOP,
          metadata: "",
          data: "",
          epilog: "",
        },
        {
          name: "FlatBig",
          prolog: FLAT_BIG,
          metadata: "",
          data: "",
          epilog: "",
        },
      ],
    });
    registerAuditComplexity(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({ scope: ["processes"] }));
    expect(out.topProcesses[0].name).toBe("FlatBig");
  });

  it("ranks by v2 score when rankBy=scoreV2 (loop-nesting process first)", async () => {
    const fake = makeFakeServer();
    const tm1 = makeAuditComplexityClientStub({
      productVersion: "11.8",
      processes: [
        {
          name: "FlatBig",
          prolog: FLAT_BIG,
          metadata: "",
          data: "",
          epilog: "",
        },
        {
          name: "DeepLoop",
          prolog: DEEP_LOOP,
          metadata: "",
          data: "",
          epilog: "",
        },
      ],
    });
    registerAuditComplexity(fake.server, tm1);
    const out = parseResult(
      await fake.getHandler()({ scope: ["processes"], rankBy: "scoreV2" }),
    );
    expect(out.topProcesses[0].name).toBe("DeepLoop");
    expect(out.topProcesses[0].totals.scoreV2).toBeGreaterThan(
      out.topProcesses[1].totals.scoreV2,
    );
  });

  it("passes custom weights through to scoreV2", async () => {
    const tm1Args = {
      productVersion: "11.8",
      processes: [
        {
          name: "DeepLoop",
          prolog: DEEP_LOOP,
          metadata: "",
          data: "",
          epilog: "",
        },
      ],
    };
    const base = makeFakeServer();
    registerAuditComplexity(
      base.server,
      makeAuditComplexityClientStub(tm1Args),
    );
    const def = parseResult(await base.getHandler()({ scope: ["processes"] }));

    const tuned = makeFakeServer();
    registerAuditComplexity(
      tuned.server,
      makeAuditComplexityClientStub(tm1Args),
    );
    const out = parseResult(
      await tuned.getHandler()({
        scope: ["processes"],
        weights: { nestMult: 5 },
      }),
    );
    expect(out.topProcesses[0].totals.scoreV2).toBeGreaterThan(
      def.topProcesses[0].totals.scoreV2,
    );
  });

  it("scoreThreshold filters low-score entries", async () => {
    const fake = makeFakeServer();
    const tm1 = makeAuditComplexityClientStub({
      productVersion: "11.8",
      processes: [
        { name: "Tiny", prolog: "x=1;", metadata: "", data: "", epilog: "" },
        {
          name: "Big",
          prolog: "IF(a=1);\n  IF(b=1);\n    c=1;\n  ENDIF;\nENDIF;",
          metadata: "",
          data: "",
          epilog: "",
        },
      ],
    });
    registerAuditComplexity(fake.server, tm1);
    const out = parseResult(
      await fake.getHandler()({ scope: ["processes"], scoreThreshold: 10 }),
    );
    expect(
      out.topProcesses.every(
        (p: { totals: { score: number } }) => p.totals.score >= 10,
      ),
    ).toBe(true);
  });

  it("scope=antipatterns reports findings and fails on an error-severity rule", async () => {
    const fake = makeFakeServer();
    const tm1 = makeAuditComplexityClientStub({
      productVersion: "11.8",
      processes: [
        {
          name: "Daily_Load",
          prolog: "CubeClearData('Sales');",
          metadata: "",
          data: "",
          epilog: "",
        },
      ],
    });
    registerAuditComplexity(fake.server, tm1);
    const out = parseResult(
      await fake.getHandler()({ scope: ["antipatterns"] }),
    );
    expect(
      out.antipatterns.findings.map((f: { rule: string }) => f.rule),
    ).toContain("destructive-unguarded");
    expect(out.antipatterns.summary.error).toBe(1);
    expect(out.status).toBe("fail");
  });

  it("antipatterns is not scanned by default", async () => {
    const fake = makeFakeServer();
    const tm1 = makeAuditComplexityClientStub({
      productVersion: "11.8",
      processes: [
        {
          name: "Daily_Load",
          prolog: "CubeClearData('Sales');",
          metadata: "",
          data: "",
          epilog: "",
        },
      ],
    });
    registerAuditComplexity(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({}));
    expect(out.antipatterns).toBeNull();
    expect(out.status).toBe("pass");
  });

  // ── consistency fan-out (one getVariables call per process) ─────────────
  // ── consistency variables: one bulk request, not one per process ────────
  describe("consistency variables", () => {
    const proc = (name: string) => ({
      name,
      prolog: "",
      metadata: "",
      data: "",
      epilog: "",
    });

    it("asks for every process's variables in a single call", async () => {
      // The old shape was one getVariables round trip per process — 221 of
      // them on a real model. `Variables` is a complex property the process
      // list can carry, so one request answers for all of them.
      const processes = Array.from({ length: 24 }, (_, i) => proc(`P${i}`));
      let calls = 0;
      const fake = makeFakeServer();
      const tm1 = makeAuditComplexityClientStub({
        productVersion: "11.8",
        processes,
        getAllVariablesImpl: async () => {
          calls++;
          return new Map(
            processes.map((p) => [
              p.name,
              [{ name: `p${p.name}`, type: "Numeric" as const, position: 1 }],
            ]),
          );
        },
      });
      registerAuditComplexity(fake.server, tm1);
      const out = parseResult(
        await fake.getHandler()({ scope: ["consistency"] }),
      );

      expect(calls).toBe(1);
      expect(out.consistency.prefixConvention.total).toBe(processes.length);
    });

    it("keeps cohort order tied to the process list, not to the map", async () => {
      // groupByCohort's sort is stable, so cohort order follows first
      // encounter in processVarInputs. Iterating the process list rather than
      // the returned Map keeps that order independent of insertion order.
      const processes = [
        proc("Zeta_Alpha"),
        proc("Alpha_Beta"),
        proc("Beta_Alpha"),
        proc("Gamma_Beta"),
      ];
      const fake = makeFakeServer();
      const tm1 = makeAuditComplexityClientStub({
        productVersion: "11.8",
        processes,
        getAllVariablesImpl: async () =>
          // Deliberately reversed: the map order must not leak into the result.
          new Map(
            [...processes]
              .reverse()
              .map((p) => [
                p.name,
                [{ name: "pYear", type: "Numeric" as const, position: 1 }],
              ]),
          ),
      });
      registerAuditComplexity(fake.server, tm1);
      const out = parseResult(
        await fake.getHandler()({ scope: ["consistency"] }),
      );

      expect(
        out.consistency.cohorts.map((c: { key: string }) => c.key),
      ).toEqual(["alpha", "beta"]);
      expect(out.consistency.cohorts[0].members).toEqual([
        "Beta_Alpha",
        "Zeta_Alpha",
      ]);
    });

    it("treats a process missing from the response as having no variables", async () => {
      // Not a hypothetical: $select omits the complex property entirely for a
      // process that has none, so the map legitimately lacks that key. It must
      // read as "no variables" — the same answer the per-process call gave —
      // and never as a failure.
      const processes = [proc("Known"), proc("Absent")];
      const fake = makeFakeServer();
      const tm1 = makeAuditComplexityClientStub({
        productVersion: "11.8",
        processes,
        getAllVariablesImpl: async () =>
          new Map([
            [
              "Known",
              [{ name: "pYear", type: "Numeric" as const, position: 1 }],
            ],
          ]),
      });
      registerAuditComplexity(fake.server, tm1);
      const out = parseResult(
        await fake.getHandler()({ scope: ["consistency"] }),
      );
      // Prefix convention counts processes that HAVE variables, so the
      // omitted one contributes nothing — exactly as an empty array would.
      expect(out.consistency.prefixConvention.total).toBe(1);
    });

    it("keeps fail-fast: a failed request fails the tool call", async () => {
      // A cross-process aggregate built from a partial scan is quietly wrong,
      // which is worse than an error.
      const fake = makeFakeServer();
      const tm1 = makeAuditComplexityClientStub({
        productVersion: "11.8",
        processes: [proc("P1"), proc("P2")],
        getAllVariablesImpl: async () => {
          throw new Error("TM1 rejected the variables query");
        },
      });
      registerAuditComplexity(fake.server, tm1);
      await expect(
        fake.getHandler()({ scope: ["consistency"] }),
      ).rejects.toThrow("TM1 rejected the variables query");
    });
  });
});
