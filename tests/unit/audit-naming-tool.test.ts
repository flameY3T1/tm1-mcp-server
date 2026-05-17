import { describe, it, expect } from "vitest";
import { registerAuditNaming } from "../../src/tools/analysis/audit-naming.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * Minimal fake McpServer that records the handler registered by server.tool(...).
 * Mirrors only what registerAuditNaming touches.
 */
function makeFakeServer() {
  let captured: ToolHandler | null = null;
  let toolName = "";
  const server = {
    tool: (
      name: string,
      _desc: string,
      _schema: unknown,
      handler: ToolHandler,
    ) => {
      toolName = name;
      captured = handler;
    },
  };
  return {
    server: server as unknown as Parameters<typeof registerAuditNaming>[0],
    getHandler: () => {
      if (!captured) throw new Error("handler not registered");
      return captured;
    },
    getName: () => toolName,
  };
}

interface FakeTM1Args {
  productVersion: string;
  cubes?: Array<{ name: string }>;
  dimensions?: Array<{ name: string; hierarchies: string[] }>;
  processes?: Array<{ name: string }>;
  chores?: Array<{ name: string }>;
  variables?: Record<string, Array<{ name: string }>>;
  elementsResponse?: {
    value: Array<{
      Name: string;
      Hierarchies: Array<{ Name: string; Elements: Array<{ Name: string }> }>;
    }>;
  };
  views?: Record<string, Array<{ name: string }>>;
  subsets?: Record<string, Array<{ name: string }>>;
}

function makeFakeTM1Client(args: FakeTM1Args) {
  return {
    server: { getInfo: async () => ({ productVersion: args.productVersion }) },
    cubes: { list: async () => args.cubes ?? [] },
    dimensions: { list: async () => args.dimensions ?? [] },
    processes: {
      list: async () => args.processes ?? [],
      getVariables: async (p: string) => args.variables?.[p] ?? [],
    },
    chores: { list: async () => args.chores ?? [] },
    views: { list: async (cube: string) => args.views?.[cube] ?? [] },
    subsets: {
      list: async (dim: string, hier: string) =>
        args.subsets?.[`${dim}/${hier}`] ?? [],
    },
    request: async () => args.elementsResponse ?? { value: [] },
  } as unknown as Parameters<typeof registerAuditNaming>[1];
}

function parseResult(raw: unknown): {
  status: string;
  detectedMajor: number;
  appliedMajor: number;
  invalidCount: number;
  truncated: boolean;
  findings: Array<{ objectKind: string; objectName: string; violations: Array<{ rule: string }> }>;
  scanned: Record<string, number>;
  summary: { byKind: Record<string, number>; byRule: Record<string, number> };
} {
  const result = raw as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text);
}

describe("tm1_audit_naming tool", () => {
  it("registers under the expected name", () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({ productVersion: "11.8.01100" });
    registerAuditNaming(fake.server, tm1);
    expect(fake.getName()).toBe("tm1_audit_naming");
  });

  it("returns pass when all objects are clean", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8.01100",
      cubes: [{ name: "Sales" }, { name: "Forecast" }],
      dimensions: [{ name: "Product", hierarchies: ["Product"] }],
      processes: [{ name: "Load_Actuals" }],
      chores: [{ name: "Nightly" }],
    });
    registerAuditNaming(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({}));
    expect(out.status).toBe("pass");
    expect(out.invalidCount).toBe(0);
    expect(out.appliedMajor).toBe(11);
  });

  it("flags reserved char in cube name and control prefix", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8.01100",
      cubes: [{ name: "Bad;Cube" }, { name: "}Hidden" }],
    });
    registerAuditNaming(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({ includeControl: true }));
    expect(out.status).toBe("fail");
    expect(out.invalidCount).toBe(2);
    const rules = out.findings.flatMap((f) => f.violations.map((v) => v.rule));
    expect(rules).toContain("server_reserved_char");
    expect(rules).toContain("leading_control_prefix");
  });

  it("excludes control objects by default and includes them on opt-in", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8.01100",
      cubes: [{ name: "}Stats" }, { name: "Sales" }],
    });
    registerAuditNaming(fake.server, tm1);
    const handler = fake.getHandler();
    const defaultOut = parseResult(await handler({}));
    expect(defaultOut.scanned.cubes).toBe(1);
    expect(defaultOut.invalidCount).toBe(0);

    const withControl = parseResult(await handler({ includeControl: true }));
    expect(withControl.scanned.cubes).toBe(2);
    expect(withControl.invalidCount).toBe(1);
  });

  it("applies v12-only TAB rule when server is v12", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "12.0.0",
      dimensions: [{ name: "Region", hierarchies: ["Region"] }],
      elementsResponse: {
        value: [
          {
            Name: "Region",
            Hierarchies: [{ Name: "Region", Elements: [{ Name: "North\tWest" }] }],
          },
        ],
      },
    });
    registerAuditNaming(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({ scope: ["elements"] }));
    expect(out.appliedMajor).toBe(12);
    expect(out.invalidCount).toBe(1);
    expect(out.findings[0]!.violations[0]!.rule).toBe("element_contains_tab");
  });

  it("does NOT flag TAB on v11 server even if elements contain it", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8.01100",
      dimensions: [{ name: "Region", hierarchies: ["Region"] }],
      elementsResponse: {
        value: [
          {
            Name: "Region",
            Hierarchies: [{ Name: "Region", Elements: [{ Name: "North\tWest" }] }],
          },
        ],
      },
    });
    registerAuditNaming(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({ scope: ["elements"] }));
    expect(out.appliedMajor).toBe(11);
    expect(out.invalidCount).toBe(0);
  });

  it("versionOverride='12' forces v12 rules on v11 server", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8.01100",
      dimensions: [{ name: "Region", hierarchies: ["Region"] }],
      elementsResponse: {
        value: [
          {
            Name: "Region",
            Hierarchies: [{ Name: "Region", Elements: [{ Name: "a\tb" }] }],
          },
        ],
      },
    });
    registerAuditNaming(fake.server, tm1);
    const out = parseResult(
      await fake.getHandler()({ scope: ["elements"], versionOverride: "12" }),
    );
    expect(out.detectedMajor).toBe(11);
    expect(out.appliedMajor).toBe(12);
    expect(out.invalidCount).toBe(1);
  });

  it("flags invalid process variable identifiers", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8.01100",
      processes: [{ name: "Load" }],
      variables: { Load: [{ name: "1bad" }, { name: "v-dash" }, { name: "vOK" }] },
    });
    registerAuditNaming(fake.server, tm1);
    const out = parseResult(
      await fake.getHandler()({ scope: ["processVariables"] }),
    );
    expect(out.scanned.processVariables).toBe(3);
    expect(out.invalidCount).toBe(2);
    const rules = out.findings.flatMap((f) => f.violations.map((v) => v.rule));
    expect(rules).toContain("process_var_leading_non_letter");
    expect(rules).toContain("process_var_invalid_char");
  });

  it("respects maxFindings cap and reports truncation", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8.01100",
      cubes: Array.from({ length: 5 }, (_, i) => ({ name: `Bad;${i}` })),
    });
    registerAuditNaming(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({ maxFindings: 2 }));
    expect(out.invalidCount).toBe(5);
    expect(out.findings.length).toBe(2);
    expect(out.truncated).toBe(true);
  });

  it("scope subset of kinds skips unrelated calls", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8.01100",
      cubes: [{ name: "Bad;Cube" }],
      processes: [{ name: "Bad;Proc" }],
    });
    registerAuditNaming(fake.server, tm1);
    const out = parseResult(await fake.getHandler()({ scope: ["cubes"] }));
    expect(out.scanned.cubes).toBe(1);
    expect(out.scanned.processes).toBe(0);
    expect(out.invalidCount).toBe(1);
  });
});
