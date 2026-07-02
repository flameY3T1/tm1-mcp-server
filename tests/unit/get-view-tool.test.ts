import { describe, it, expect } from "vitest";
import { z, type ZodRawShape } from "zod";
import { registerGetView } from "../../src/tools/celldata/get-view.js";
import { ViewService } from "../../src/tm1-client/services/view-service.js";
import type { TM1Client } from "../../src/tm1-client.js";

// A 2×2 view: columns [Jan, Feb] (Time), rows [Plan, Actual] (Version).
// Cells are axis0-fastest: [Plan/Jan, Plan/Feb, Actual/Jan, Actual/Feb].
const ALL_CELLS = [
  { Value: 10, FormattedValue: "10" },
  { Value: 20, FormattedValue: "20" },
  { Value: 11, FormattedValue: "11" },
  { Value: 22, FormattedValue: "22" },
];

const AXES = [
  {
    Tuples: [
      { Members: [{ Name: "Jan", Hierarchy: { Name: "Time" } }] },
      { Members: [{ Name: "Feb", Hierarchy: { Name: "Time" } }] },
    ],
  },
  {
    Tuples: [
      { Members: [{ Name: "Plan", Hierarchy: { Name: "Version" } }] },
      { Members: [{ Name: "Actual", Hierarchy: { Name: "Version" } }] },
    ],
  },
];

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}>;

// Fake McpServer that records the handler and parses args through the captured
// Zod schema first — so PAGINATION_SCHEMA/.default() values apply like prod.
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
    server: server as unknown as Parameters<typeof registerGetView>[0],
    getHandler: (): ToolHandler => {
      if (!captured || !parser) throw new Error("handler not registered");
      const p = parser;
      const h = captured;
      return (args) => h(p.parse(args) as Record<string, unknown>);
    },
  };
}

// Real ViewService over a mock http.request that honours $top/$skip on the
// Cells expand (mirrors TM1's server-side pagination).
function makeTM1Client(paths: string[]): TM1Client {
  const request = async (_method: string, path: string) => {
    paths.push(path);
    const top = path.match(/\$top=(\d+)/);
    const skip = path.match(/\$skip=(\d+)/);
    const start = skip ? Number(skip[1]) : 0;
    const end = top ? start + Number(top[1]) : ALL_CELLS.length;
    return { ID: "x", Cells: ALL_CELLS.slice(start, end), Axes: AXES };
  };
  const views = new ViewService({ request } as unknown as ConstructorParameters<
    typeof ViewService
  >[0]);
  return { views } as unknown as TM1Client;
}

describe("tm1_get_view tool", () => {
  it("paginates: pushes $top/$skip server-side and reports has_more when capped", async () => {
    const paths: string[] = [];
    const { server, getHandler } = makeFakeServer();
    registerGetView(server, makeTM1Client(paths));

    const res = await getHandler()({ cubeName: "C", viewName: "V", limit: 2 });
    const env = JSON.parse(res.content[0]!.text);

    expect(paths[0]).toContain("$top=2");
    expect(paths[0]).toContain("$skip=0");
    expect(env.count).toBe(2);
    expect(env.total).toBe(4);
    expect(env.has_more).toBe(true);
    expect(env.next_offset).toBe(2);
    expect(env.items).toHaveLength(2);
  });

  it("respects a page cap at a non-zero offset (last page, no more)", async () => {
    const paths: string[] = [];
    const { server, getHandler } = makeFakeServer();
    registerGetView(server, makeTM1Client(paths));

    const res = await getHandler()({ cubeName: "C", viewName: "V", limit: 2, offset: 2 });
    const env = JSON.parse(res.content[0]!.text);

    expect(paths[0]).toContain("$top=2");
    expect(paths[0]).toContain("$skip=2");
    expect(env.offset).toBe(2);
    expect(env.count).toBe(2);
    expect(env.has_more).toBe(false);
    expect(env.next_offset).toBeNull();
  });

  it("format='markdown' renders a pivot grid for the full result", async () => {
    const paths: string[] = [];
    const { server, getHandler } = makeFakeServer();
    registerGetView(server, makeTM1Client(paths));

    const res = await getHandler()({
      cubeName: "C",
      viewName: "V",
      fetchAll: true,
      format: "markdown",
    });
    const md = res.content[0]!.text;

    expect(paths[0]).not.toContain("$top=");
    expect(md).toContain("| Version | Jan | Feb |");
    expect(md).toContain("| Plan | 10 | 20 |");
    expect(md).toContain("| Actual | 11 | 22 |");
    // markdown mode still attaches structuredContent (output-schema roundtrip)
    expect(res.structuredContent?.cubeName).toBe("C");
  });
});
