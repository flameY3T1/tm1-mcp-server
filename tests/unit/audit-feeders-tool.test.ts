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

  it("flags feeder broader than the cube's densest rule (S1)", async () => {
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
    expect(out.status).toBe("fail");
    expect(out.summary.byRule.feeder_broader_than_rule).toBe(1);
    expect(out.findings[0].rule).toBe("feeder_broader_than_rule");
    expect(out.findings[0].severity).toBe("hint");
    expect(out.findings[0].cube).toBe("Sales");
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
            ...Array.from({ length: 6 }, () => "['A','B'] => ['D'];"),
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
