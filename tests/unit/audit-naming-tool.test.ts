import { describe, it, expect } from "vitest";
import { z, type ZodRawShape } from "zod";
import { registerAuditNaming } from "../../src/tools/analysis/audit-naming.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * Minimal fake McpServer that records the handler registered by server.tool(...).
 * Mirrors the real SDK by parsing args through the captured Zod schema before
 * invoking the handler — that applies .default() values just like prod.
 */
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
    server: server as unknown as Parameters<typeof registerAuditNaming>[0],
    getHandler: (): ToolHandler => {
      if (!captured || !parser) throw new Error("handler not registered");
      const p = parser;
      const h = captured;
      return (args) => h(p.parse(args) as Record<string, unknown>);
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
  /** Element names per "DimName/HierName" key. Mock honors $top/$skip/$count=true. */
  elementsByHier?: Record<string, Array<string>>;
  views?: Record<string, Array<{ name: string }>>;
  subsets?: Record<string, Array<{ name: string }>>;
}

const ELEMENTS_RE =
  /\/api\/v1\/Dimensions\('([^']+)'\)\/Hierarchies\('([^']+)'\)\/Elements\?(.*)$/;

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
    request: async (_method: string, path: string) => {
      const m = ELEMENTS_RE.exec(path);
      if (!m) throw new Error(`unexpected path: ${path}`);
      const dim = decodeURIComponent(m[1]!);
      const hier = decodeURIComponent(m[2]!);
      const names = args.elementsByHier?.[`${dim}/${hier}`] ?? [];
      const qs = new URLSearchParams(m[3]!);
      const top = Number(qs.get("$top") ?? names.length);
      const skip = Number(qs.get("$skip") ?? 0);
      const wantCount = qs.get("$count") === "true";
      const value = names.slice(skip, skip + top).map((Name) => ({ Name }));
      return wantCount ? { "@odata.count": names.length, value } : { value };
    },
  } as unknown as Parameters<typeof registerAuditNaming>[1];
}

interface FindingGroup {
  objectKind: string;
  parent?: string;
  dimension?: string;
  hierarchy?: string;
  ruleBreakdown: Record<string, number>;
  sampleNames: string[];
  totalCount: number;
}

function parseResult(raw: unknown): {
  status: string;
  detectedMajor: number;
  appliedMajor: number;
  invalidCount: number;
  truncated: boolean;
  findings?: Array<{ objectKind: string; objectName: string; violations: Array<{ rule: string }> }>;
  findingsByGroup?: FindingGroup[];
  scanned: Record<string, number>;
  summary: { byKind: Record<string, number>; byRule: Record<string, number> };
  elementsTruncated: Array<{
    dimension: string;
    hierarchy: string;
    elementCount: number;
    scannedCount: number;
  }>;
  totalElementsInScope: number;
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
      elementsByHier: { "Region/Region": ["North\tWest"] },
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
      elementsByHier: { "Region/Region": ["North\tWest"] },
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
      elementsByHier: { "Region/Region": ["a\tb"] },
    });
    registerAuditNaming(fake.server, tm1);
    const out = parseResult(
      await fake.getHandler()({ scope: ["elements"], versionOverride: "12" }),
    );
    expect(out.detectedMajor).toBe(11);
    expect(out.appliedMajor).toBe(12);
    expect(out.invalidCount).toBe(1);
  });

  it("paginates element scan across multiple pages", async () => {
    const fake = makeFakeServer();
    const names = ["e1", "e2", "e3", "e4", "e5", "e6", "e7"];
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8.01100",
      dimensions: [{ name: "Big", hierarchies: ["Big"] }],
      elementsByHier: { "Big/Big": names },
    });
    registerAuditNaming(fake.server, tm1);
    const out = parseResult(
      await fake.getHandler()({
        scope: ["elements"],
        elementsPageSize: 1000,
        maxElementsPerDim: 1000,
      }),
    );
    expect(out.scanned.elements).toBe(7);
    expect(out.invalidCount).toBe(0);
    expect(out.elementsTruncated.length).toBe(0);
  });

  it("paginates element scan via $skip across multiple HTTP pages", async () => {
    // Zod schema clamps elementsPageSize to min(1000), so verify multi-page
    // $skip behaviour against a dimension whose count exceeds one page.
    const total = 2500;
    const names = Array.from({ length: total }, (_, i) => `e${i}`);
    const fake = makeFakeServer();
    let requestCount = 0;
    const tm1 = {
      server: { getInfo: async () => ({ productVersion: "11.8.01100" }) },
      cubes: { list: async () => [] },
      dimensions: {
        list: async () => [{ name: "Big", hierarchies: ["Big"] }],
      },
      processes: { list: async () => [], getVariables: async () => [] },
      chores: { list: async () => [] },
      views: { list: async () => [] },
      subsets: { list: async () => [] },
      request: async (_method: string, path: string) => {
        requestCount++;
        const m = ELEMENTS_RE.exec(path);
        if (!m) throw new Error(`unexpected path: ${path}`);
        const qs = new URLSearchParams(m[3]!);
        const top = Number(qs.get("$top") ?? names.length);
        const skip = Number(qs.get("$skip") ?? 0);
        const wantCount = qs.get("$count") === "true";
        const value = names.slice(skip, skip + top).map((Name) => ({ Name }));
        return wantCount ? { "@odata.count": names.length, value } : { value };
      },
    } as unknown as Parameters<typeof registerAuditNaming>[1];
    registerAuditNaming(fake.server, tm1);
    const out = parseResult(
      await fake.getHandler()({
        scope: ["elements"],
        elementsPageSize: 1000,
        maxElementsPerDim: 1000000,
      }),
    );
    expect(out.scanned.elements).toBe(total);
    // Pages: probe (skip=0, count=true) + skip=1000 + skip=2000 → 3 requests.
    expect(requestCount).toBe(3);
  });

  it("reports scanned.dimensions when only hierarchies are in scope", async () => {
    const fake = makeFakeServer();
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8.01100",
      dimensions: [
        { name: "Product", hierarchies: ["Product", "ByBrand"] },
        { name: "Time", hierarchies: ["Time"] },
      ],
    });
    registerAuditNaming(fake.server, tm1);
    const out = parseResult(
      await fake.getHandler()({ scope: ["hierarchies"] }),
    );
    expect(out.scanned.hierarchies).toBe(3);
    expect(out.scanned.dimensions).toBe(2);
  });

  it("respects elementsPageSize for paginated reads", async () => {
    const fake = makeFakeServer();
    const names = Array.from({ length: 5 }, (_, i) => `valid_${i}`);
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8.01100",
      dimensions: [{ name: "Mini", hierarchies: ["Mini"] }],
      elementsByHier: { "Mini/Mini": names },
    });
    registerAuditNaming(fake.server, tm1);
    const out = parseResult(
      await fake.getHandler()({ scope: ["elements"], elementsPageSize: 2000 }),
    );
    expect(out.scanned.elements).toBe(5);
  });

  it("truncates dimension above maxElementsPerDim and reports it transparently", async () => {
    const fake = makeFakeServer();
    const big = Array.from({ length: 10 }, (_, i) => `e${i}`);
    const small = ["ok1", "ok2"];
    const tm1 = makeFakeTM1Client({
      productVersion: "11.8.01100",
      dimensions: [
        { name: "Huge", hierarchies: ["Huge"] },
        { name: "Small", hierarchies: ["Small"] },
      ],
      elementsByHier: { "Huge/Huge": big, "Small/Small": small },
    });
    registerAuditNaming(fake.server, tm1);
    const out = parseResult(
      await fake.getHandler()({ scope: ["elements"], maxElementsPerDim: 5 }),
    );
    expect(out.scanned.elements).toBe(7); // first 5 of Huge + all 2 of Small
    expect(out.elementsTruncated).toEqual([
      { dimension: "Huge", hierarchy: "Huge", elementCount: 10, scannedCount: 5 },
    ]);
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

  describe("summary mode", () => {
    it("summary=true swaps findings[] for findingsByGroup[] and omits truncation", async () => {
      const fake = makeFakeServer();
      const elements = ["Bad;1", "Bad;2", "Bad;3", "Bad;4"];
      const tm1 = makeFakeTM1Client({
        productVersion: "11.8.01100",
        dimensions: [{ name: "Produkt", hierarchies: ["Produkt"] }],
        elementsByHier: { "Produkt/Produkt": elements },
      });
      registerAuditNaming(fake.server, tm1);
      const out = parseResult(
        await fake.getHandler()({ scope: ["elements"], summary: true, maxFindings: 2 }),
      );
      expect(out.invalidCount).toBe(4);
      expect(out.findings).toBeUndefined();
      expect(out.truncated).toBe(false);
      expect(out.findingsByGroup).toBeDefined();
      expect(out.findingsByGroup!.length).toBe(1);
      const g = out.findingsByGroup![0]!;
      expect(g.objectKind).toBe("element");
      expect(g.dimension).toBe("Produkt");
      expect(g.hierarchy).toBe("Produkt");
      expect(g.totalCount).toBe(4);
      expect(g.ruleBreakdown).toEqual({ server_reserved_char: 4 });
    });

    it("summary aggregates rule counts per (objectKind, parent) group", async () => {
      const fake = makeFakeServer();
      const tm1 = makeFakeTM1Client({
        productVersion: "11.8.01100",
        dimensions: [
          { name: "DimA", hierarchies: ["DimA"] },
          { name: "DimB", hierarchies: ["DimB"] },
        ],
        elementsByHier: {
          "DimA/DimA": ["Bad;1", "Bad;2", "+leading"],
          "DimB/DimB": ["Bad;3"],
        },
      });
      registerAuditNaming(fake.server, tm1);
      const out = parseResult(
        await fake.getHandler()({ scope: ["elements"], summary: true }),
      );
      expect(out.findingsByGroup!.length).toBe(2);
      const dimA = out.findingsByGroup!.find((g) => g.dimension === "DimA")!;
      const dimB = out.findingsByGroup!.find((g) => g.dimension === "DimB")!;
      expect(dimA.totalCount).toBe(3);
      expect(dimA.ruleBreakdown.server_reserved_char).toBe(2);
      expect(dimA.ruleBreakdown.element_leading_arithmetic).toBe(1);
      expect(dimB.totalCount).toBe(1);
      expect(dimB.ruleBreakdown.server_reserved_char).toBe(1);
    });

    it("summary samples first 3 element names per group", async () => {
      const fake = makeFakeServer();
      const names = ["Bad;A", "Bad;B", "Bad;C", "Bad;D", "Bad;E"];
      const tm1 = makeFakeTM1Client({
        productVersion: "11.8.01100",
        dimensions: [{ name: "Big", hierarchies: ["Big"] }],
        elementsByHier: { "Big/Big": names },
      });
      registerAuditNaming(fake.server, tm1);
      const out = parseResult(
        await fake.getHandler()({ scope: ["elements"], summary: true }),
      );
      const g = out.findingsByGroup![0]!;
      expect(g.sampleNames.length).toBe(3);
      expect(g.sampleNames).toEqual(["Bad;A", "Bad;B", "Bad;C"]);
    });

    it("summary groups non-element kinds under objectKind without parent", async () => {
      const fake = makeFakeServer();
      const tm1 = makeFakeTM1Client({
        productVersion: "11.8.01100",
        cubes: [{ name: "Bad;X" }, { name: "Bad;Y" }],
        processes: [{ name: "Bad;Proc" }],
      });
      registerAuditNaming(fake.server, tm1);
      const out = parseResult(
        await fake.getHandler()({ scope: ["cubes", "processes"], summary: true }),
      );
      const cubeGroup = out.findingsByGroup!.find((g) => g.objectKind === "cube")!;
      const procGroup = out.findingsByGroup!.find((g) => g.objectKind === "process")!;
      expect(cubeGroup.totalCount).toBe(2);
      expect(cubeGroup.parent).toBeUndefined();
      expect(cubeGroup.dimension).toBeUndefined();
      expect(cubeGroup.sampleNames).toEqual(["Bad;X", "Bad;Y"]);
      expect(procGroup.totalCount).toBe(1);
    });

    it("reports totalElementsInScope (scanned + truncated remainder)", async () => {
      const fake = makeFakeServer();
      const big = Array.from({ length: 10 }, (_, i) => `e${i}`);
      const small = ["ok1", "ok2"];
      const tm1 = makeFakeTM1Client({
        productVersion: "11.8.01100",
        dimensions: [
          { name: "Huge", hierarchies: ["Huge"] },
          { name: "Small", hierarchies: ["Small"] },
        ],
        elementsByHier: { "Huge/Huge": big, "Small/Small": small },
      });
      registerAuditNaming(fake.server, tm1);
      const out = parseResult(
        await fake.getHandler()({ scope: ["elements"], maxElementsPerDim: 5 }),
      );
      // scanned: 5 from Huge + 2 from Small = 7. Total: 10 + 2 = 12.
      expect(out.scanned.elements).toBe(7);
      expect(out.totalElementsInScope).toBe(12);
    });

    it("totalElementsInScope is 0 when elements not in scope", async () => {
      const fake = makeFakeServer();
      const tm1 = makeFakeTM1Client({
        productVersion: "11.8.01100",
        cubes: [{ name: "Sales" }],
      });
      registerAuditNaming(fake.server, tm1);
      const out = parseResult(await fake.getHandler()({ scope: ["cubes"] }));
      expect(out.totalElementsInScope).toBe(0);
    });

    it("summary=false (default) keeps legacy findings[] response", async () => {
      const fake = makeFakeServer();
      const tm1 = makeFakeTM1Client({
        productVersion: "11.8.01100",
        cubes: [{ name: "Bad;X" }],
      });
      registerAuditNaming(fake.server, tm1);
      const out = parseResult(await fake.getHandler()({}));
      expect(out.findings).toBeDefined();
      expect(out.findingsByGroup).toBeUndefined();
      expect(out.findings!.length).toBe(1);
    });
  });
});
