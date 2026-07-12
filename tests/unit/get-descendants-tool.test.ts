import { describe, it, expect } from "vitest";
import { z, type ZodRawShape } from "zod";
import { registerGetDescendants } from "../../src/tools/metadata/get-descendants.js";
import { HierarchyService } from "../../src/tm1-client/services/hierarchy-service.js";
import type { TM1Client } from "../../src/tm1-client.js";

// Synthetic hierarchy: consolidation "Total" with 5 leaf children. Children
// are derived client-side from Parents, mirroring the real OData shape.
const POOL = [
  { Name: "Total", Type: "Consolidated", Level: 1, Parents: [] },
  ...["E1", "E2", "E3", "E4", "E5"].map((Name) => ({
    Name,
    Type: "Numeric",
    Level: 0,
    Parents: [{ Name: "Total" }],
  })),
];

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
    server: server as unknown as Parameters<typeof registerGetDescendants>[0],
    getHandler: (): ToolHandler => {
      if (!captured || !parser) throw new Error("handler not registered");
      const p = parser;
      const h = captured;
      return (args) => h(p.parse(args) as Record<string, unknown>);
    },
  };
}

function makeTM1Client(): TM1Client {
  const request = async (_method: string, _path: string) => ({ Name: "H", Elements: POOL });
  const hierarchies = new HierarchyService({ request } as unknown as ConstructorParameters<
    typeof HierarchyService
  >[0]);
  return { hierarchies } as unknown as TM1Client;
}

describe("tm1_get_descendants tool", () => {
  it("returns the full set with truncated=false when under the default cap", async () => {
    const { server, getHandler } = makeFakeServer();
    registerGetDescendants(server, makeTM1Client());

    const res = await getHandler()({ dimensionName: "D", hierarchyName: "H", elementName: "Total" });
    const out = JSON.parse(res.content[0]!.text);

    expect(out.descendants).toHaveLength(5);
    expect(out.truncated).toBe(false);
  });

  it("caps descendants at topN and sets truncated=true", async () => {
    const { server, getHandler } = makeFakeServer();
    registerGetDescendants(server, makeTM1Client());

    const res = await getHandler()({
      dimensionName: "D",
      hierarchyName: "H",
      elementName: "Total",
      topN: 3,
    });
    const out = JSON.parse(res.content[0]!.text);

    expect(out.descendants).toHaveLength(3);
    expect(out.descendants.map((d: { name: string }) => d.name)).toEqual(["E1", "E2", "E3"]);
    expect(out.truncated).toBe(true);
  });

  it("topN equal to the set size does not truncate", async () => {
    const { server, getHandler } = makeFakeServer();
    registerGetDescendants(server, makeTM1Client());

    const res = await getHandler()({
      dimensionName: "D",
      hierarchyName: "H",
      elementName: "Total",
      topN: 5,
    });
    const out = JSON.parse(res.content[0]!.text);

    expect(out.descendants).toHaveLength(5);
    expect(out.truncated).toBe(false);
  });
});
