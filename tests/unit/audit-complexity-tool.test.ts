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
  return {
    server: { getInfo: async () => ({ productVersion: args.productVersion }) },
    processes: {
      getAllCode: async () => args.processes ?? [],
      getVariables: async (name: string) => args.variables?.[name] ?? [],
    },
    cubes: { getAllRules: async () => args.rules ?? [] },
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
