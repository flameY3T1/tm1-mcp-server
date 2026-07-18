import { describe, expect, it } from "vitest";
import { z, type ZodRawShape } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";
import type { CubeRules } from "../../src/types.js";
import { registerGetAllCubeRules } from "../../src/tools/model-building/get-all-cube-rules.js";

// Token-opt 2026-07-18: tm1_get_all_cube_rules default-caps full-rules
// responses at 50 cubes (server-side $top); summary mode still surveys the
// whole model by default, and onlyWithRules keeps its client-side filter.

type Handler = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

// Capture the raw zod shape + handler, then parse inputs through
// z.object(shape) so schema defaults apply exactly as the live SDK would.
function capture(client: TM1Client): { schema: ZodRawShape; handler: Handler } {
  let schema: ZodRawShape | undefined;
  let handler: Handler | undefined;
  const server = {
    tool: (_name: string, _desc: string, s: ZodRawShape, h: Handler) => {
      schema = s;
      handler = h;
    },
  } as unknown as McpServer;
  registerGetAllCubeRules(server, client);
  if (!schema || !handler) throw new Error("tool was not registered");
  return { schema, handler };
}

interface BulkResult {
  count: number;
  returned: number;
  truncated: boolean;
  cubes: Array<Record<string, unknown>>;
}

async function run(client: TM1Client, input: Record<string, unknown>): Promise<BulkResult> {
  const { schema, handler } = capture(client);
  const args = z.object(schema).parse(input);
  const res = await handler(args as Record<string, unknown>, {});
  return JSON.parse(res.content[0]!.text) as BulkResult;
}

// Bulk-rules stub mirroring the CubeService.getAllRules overload: plain array
// without a cap, { items, total } when the tool pushes $top server-side.
function bulkRulesClient(rows: CubeRules[]): TM1Client {
  return {
    cubes: {
      getAllRules: async (_includeControl?: boolean, top?: number) =>
        top === undefined ? rows : { items: rows.slice(0, top), total: rows.length },
    },
  } as unknown as TM1Client;
}

function cube(name: string, rulesText: string): CubeRules {
  return { cubeName: name, rulesText, skipCheck: rulesText.toUpperCase().includes("SKIPCHECK") };
}

describe("tm1_get_all_cube_rules default cap", () => {
  const rows = Array.from({ length: 60 }, (_, i) =>
    cube(`Cube.${String(i).padStart(2, "0")}`, i % 2 === 0 ? "SKIPCHECK;\n['A'] = N: 1;" : ""),
  );
  const client = bulkRulesClient(rows);

  it("caps full-rules responses at 50 by default and flags truncation", async () => {
    const parsed = await run(client, {});
    expect(parsed.returned).toBe(50);
    expect(parsed.cubes).toHaveLength(50);
    expect(parsed.truncated).toBe(true);
    expect(parsed.count).toBe(60);
  });

  it("explicit limit overrides the default cap", async () => {
    const parsed = await run(client, { limit: 10 });
    expect(parsed.returned).toBe(10);
    expect(parsed.truncated).toBe(true);
    expect(parsed.count).toBe(60);
  });

  it("limit=0 returns everything uncapped", async () => {
    const parsed = await run(client, { limit: 0 });
    expect(parsed.returned).toBe(60);
    expect(parsed.truncated).toBe(false);
    expect(parsed.count).toBe(60);
  });

  it("summary mode surveys all cubes by default (no cap) and drops rulesText", async () => {
    const parsed = await run(client, { summary: true });
    expect(parsed.returned).toBe(60);
    expect(parsed.truncated).toBe(false);
    expect(parsed.cubes[0]!.rulesText).toBeUndefined();
    expect(parsed.cubes[0]!.lineCount).toBeDefined();
  });

  it("explicit limit also caps summary mode", async () => {
    const parsed = await run(client, { summary: true, limit: 5 });
    expect(parsed.returned).toBe(5);
    expect(parsed.truncated).toBe(true);
    expect(parsed.count).toBe(60);
  });

  it("onlyWithRules filters client-side; count reflects the post-filter set", async () => {
    // 30 of the 60 cubes carry rules — under the default cap of 50, so no
    // truncation; count must be the post-filter total, like before the cap.
    const parsed = await run(client, { onlyWithRules: true });
    expect(parsed.returned).toBe(30);
    expect(parsed.truncated).toBe(false);
    expect(parsed.count).toBe(30);
    expect(parsed.cubes.every((c) => String(c.rulesText).trim().length > 0)).toBe(true);
  });

  it("onlyWithRules with a smaller limit truncates deterministically by name", async () => {
    const parsed = await run(client, { onlyWithRules: true, limit: 3 });
    expect(parsed.returned).toBe(3);
    expect(parsed.truncated).toBe(true);
    expect(parsed.count).toBe(30);
    expect(parsed.cubes.map((c) => c.cubeName)).toEqual(["Cube.00", "Cube.02", "Cube.04"]);
  });
});
