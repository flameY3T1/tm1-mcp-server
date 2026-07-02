import { describe, it, expect } from "vitest";
import { z, type ZodRawShape } from "zod";
import { registerGetHierarchy } from "../../src/tools/metadata/get-hierarchy.js";
import { HierarchyService } from "../../src/tm1-client/services/hierarchy-service.js";
import type { TM1Client } from "../../src/tm1-client.js";

// Synthetic pool of 5 leaf elements. The mock honours OData $top so the real
// HierarchyService applies the tool's cap exactly like the server would.
const POOL = ["E1", "E2", "E3", "E4", "E5"].map((Name) => ({
  Name,
  Type: "Numeric",
  Level: 0,
  Parents: [],
}));

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function makeFakeServer() {
  let captured: ToolHandler | null = null;
  let parser: z.ZodObject<ZodRawShape> | null = null;
  const server = {
    tool: (_name: string, _desc: string, schema: ZodRawShape, handler: ToolHandler) => {
      parser = z.object(schema);
      captured = handler;
    },
  };
  return {
    server: server as unknown as Parameters<typeof registerGetHierarchy>[0],
    getHandler: (): ToolHandler => {
      if (!captured || !parser) throw new Error("handler not registered");
      const p = parser;
      const h = captured;
      return (args) => h(p.parse(args) as Record<string, unknown>);
    },
  };
}

function makeTM1Client(paths: string[]): TM1Client {
  const request = async (_method: string, path: string) => {
    paths.push(path);
    const top = path.match(/\$top=(\d+)/);
    const n = top ? Number(top[1]) : POOL.length;
    return { Name: "H", Elements: POOL.slice(0, n) };
  };
  const hierarchies = new HierarchyService({ request } as unknown as ConstructorParameters<
    typeof HierarchyService
  >[0]);
  return { hierarchies } as unknown as TM1Client;
}

describe("tm1_get_hierarchy tool", () => {
  it("applies a default cap of 1000 when topN is omitted", async () => {
    const paths: string[] = [];
    const { server, getHandler } = makeFakeServer();
    registerGetHierarchy(server, makeTM1Client(paths));

    const res = await getHandler()({ dimensionName: "D", hierarchyName: "H" });
    const out = JSON.parse(res.content[0]!.text);

    expect(paths[0]).toContain("$top=1000");
    expect(out.elements).toHaveLength(5);
    expect(out.truncated).toBe(false);
  });

  it("sets truncated=true when the cap clips the element set", async () => {
    const paths: string[] = [];
    const { server, getHandler } = makeFakeServer();
    registerGetHierarchy(server, makeTM1Client(paths));

    const res = await getHandler()({ dimensionName: "D", hierarchyName: "H", topN: 3 });
    const out = JSON.parse(res.content[0]!.text);

    expect(paths[0]).toContain("$top=3");
    expect(out.elements).toHaveLength(3);
    expect(out.truncated).toBe(true);
  });

  it("a higher topN returns more elements and clears the truncated flag", async () => {
    const { server, getHandler } = makeFakeServer();
    const paths: string[] = [];
    registerGetHierarchy(server, makeTM1Client(paths));

    const low = JSON.parse(
      (await getHandler()({ dimensionName: "D", hierarchyName: "H", topN: 3 })).content[0]!.text,
    );
    const high = JSON.parse(
      (await getHandler()({ dimensionName: "D", hierarchyName: "H", topN: 10 })).content[0]!.text,
    );

    expect(high.elements.length).toBeGreaterThan(low.elements.length);
    expect(high.elements).toHaveLength(5);
    expect(high.truncated).toBe(false);
  });
});
