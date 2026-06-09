import { describe, it, expect } from "vitest";
import { z, type ZodRawShape } from "zod";
import { registerAuditComplexity } from "../../src/tools/analysis/audit-complexity.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function makeFakeServer() {
  let captured: ToolHandler | null = null;
  let toolName = "";
  let parser: z.ZodObject<ZodRawShape> | null = null;
  const server = {
    tool: (name: string, _d: string, schema: ZodRawShape, handler: ToolHandler) => {
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
      return (args) => h(p.parse(args) as Record<string, unknown>);
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
}

function makeFakeTM1Client(args: FakeArgs) {
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
      getVariables: async (name: string) => args.variables?.[name] ?? [],
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
  return JSON.parse(result.content[0]!.text);
}

describe("tm1_audit_complexity tool", () => {
  it("registers under the expected name", () => {
    const fake = makeFakeServer();
    registerAuditComplexity(fake.server, makeFakeTM1Client({ productVersion: "11.8" }));
    expect(fake.getName()).toBe("tm1_audit_complexity");
  });

  it("returns pass when no objects exist", async () => {
    const fake = makeFakeServer();
    registerAuditComplexity(fake.server, makeFakeTM1Client({ productVersion: "11.8" }));
    const out = parseResult(await fake.getHandler()({}));
    expect(out.status).toBe("pass");
    expect(out.scanned.processes).toBe(0);
    expect(out.scanned.rules).toBe(0);
  });

  it("scans processes and reports topProcesses sorted by score", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
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
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      processes: [
        { name: "}Stats_Process", prolog: "x=1;", metadata: "", data: "", epilog: "" },
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
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      rules: [
        { cubeName: "WithCheck", rulesText: "skipcheck;\n['A']=N:1;", skipCheck: true },
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
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      processes: [
        { name: "Load_Sales", prolog: "", metadata: "", data: "", epilog: "" },
        { name: "Aggregate_Sales", prolog: "", metadata: "", data: "", epilog: "" },
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
    const out = parseResult(await fake.getHandler()({ scope: ["consistency"] }));
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
    const tm1 = makeFakeTM1Client({ productVersion: "11.8", processes: procs });
    registerAuditComplexity(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({ scope: ["processes"], topN: 5 }));
    expect(out.scanned.processes).toBe(30);
    expect(out.topProcesses).toHaveLength(5);
    expect(out.truncated.processes).toBe(true);
  });

  it("status=pass when only trivial processes exist and no consistency issues", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
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
    const tm1 = makeFakeTM1Client({
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
  const FLAT_BIG = Array.from({ length: 10 }, () => "IF(x=1);\na=1;\nENDIF;").join("\n");
  const DEEP_LOOP =
    "WHILE(a<1);\nWHILE(b<1);\nWHILE(c<1);\nWHILE(d<1);\nx=1;\nEND;\nEND;\nEND;\nEND;";

  it("ranks by v1 score by default (branch-heavy process first)", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      processes: [
        { name: "DeepLoop", prolog: DEEP_LOOP, metadata: "", data: "", epilog: "" },
        { name: "FlatBig", prolog: FLAT_BIG, metadata: "", data: "", epilog: "" },
      ],
    });
    registerAuditComplexity(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({ scope: ["processes"] }));
    expect(out.topProcesses[0].name).toBe("FlatBig");
  });

  it("ranks by v2 score when rankBy=scoreV2 (loop-nesting process first)", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8",
      processes: [
        { name: "FlatBig", prolog: FLAT_BIG, metadata: "", data: "", epilog: "" },
        { name: "DeepLoop", prolog: DEEP_LOOP, metadata: "", data: "", epilog: "" },
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
        { name: "DeepLoop", prolog: DEEP_LOOP, metadata: "", data: "", epilog: "" },
      ],
    };
    const base = makeFakeServer();
    registerAuditComplexity(base.server, makeFakeTM1Client(tm1Args));
    const def = parseResult(await base.getHandler()({ scope: ["processes"] }));

    const tuned = makeFakeServer();
    registerAuditComplexity(tuned.server, makeFakeTM1Client(tm1Args));
    const out = parseResult(
      await tuned.getHandler()({ scope: ["processes"], weights: { nestMult: 5 } }),
    );
    expect(out.topProcesses[0].totals.scoreV2).toBeGreaterThan(
      def.topProcesses[0].totals.scoreV2,
    );
  });

  it("scoreThreshold filters low-score entries", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
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
      out.topProcesses.every((p: { totals: { score: number } }) => p.totals.score >= 10),
    ).toBe(true);
  });
});
