import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type pino from "pino";
import { slimJsonSchema } from "../../src/lib/slim-json-schema.js";
import { withAnnotations } from "../../src/tools/with-annotations.js";

const SAFE_INT_MIN = -9007199254740991;
const SAFE_INT_MAX = 9007199254740991;
const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn().mockReturnThis(),
  level: "silent",
  flush: vi.fn(),
} as unknown as pino.Logger;

describe("slimJsonSchema", () => {
  it("drops the sentinel int bounds emitted by Zod's .int()", () => {
    expect(
      slimJsonSchema({
        type: "integer",
        minimum: SAFE_INT_MIN,
        maximum: SAFE_INT_MAX,
      }),
    ).toEqual({ type: "integer" });
  });

  it("keeps real bounds, including ones adjacent to a sentinel", () => {
    expect(
      slimJsonSchema({ type: "integer", minimum: 0, maximum: 500 }),
    ).toEqual({ type: "integer", minimum: 0, maximum: 500 });

    // Only the exact sentinel goes; off-by-one is an author's real bound.
    expect(
      slimJsonSchema({
        type: "integer",
        minimum: SAFE_INT_MIN + 1,
        maximum: SAFE_INT_MAX - 1,
      }),
    ).toEqual({
      type: "integer",
      minimum: SAFE_INT_MIN + 1,
      maximum: SAFE_INT_MAX - 1,
    });

    // A mixed pair: sentinel min stripped, real max kept.
    expect(
      slimJsonSchema({ type: "integer", minimum: SAFE_INT_MIN, maximum: 500 }),
    ).toEqual({ type: "integer", maximum: 500 });
  });

  it("removes $schema", () => {
    expect(slimJsonSchema({ $schema: DRAFT_07, type: "object" })).toEqual({
      type: "object",
    });
  });

  it("recurses through properties, arrays, anyOf and $defs", () => {
    const input = {
      $schema: DRAFT_07,
      type: "object",
      properties: {
        offset: { type: "integer", minimum: 0, maximum: SAFE_INT_MAX },
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              n: {
                type: "integer",
                minimum: SAFE_INT_MIN,
                maximum: SAFE_INT_MAX,
              },
            },
          },
        },
        either: {
          anyOf: [
            { type: "integer", minimum: SAFE_INT_MIN },
            { type: "integer", maximum: SAFE_INT_MAX },
            { type: "null" },
          ],
        },
      },
      $defs: {
        Node: { type: "integer", minimum: SAFE_INT_MIN, maximum: 10 },
      },
      required: ["offset"],
      additionalProperties: false,
    };

    expect(slimJsonSchema(input)).toEqual({
      type: "object",
      properties: {
        offset: { type: "integer", minimum: 0 },
        rows: {
          type: "array",
          items: { type: "object", properties: { n: { type: "integer" } } },
        },
        either: {
          anyOf: [{ type: "integer" }, { type: "integer" }, { type: "null" }],
        },
      },
      $defs: { Node: { type: "integer", maximum: 10 } },
      required: ["offset"],
      additionalProperties: false,
    });
  });

  it("leaves keys alone inside name-keyed containers (a field may be called $schema)", () => {
    const input = {
      type: "object",
      properties: {
        $schema: { type: "string" },
        minimum: { type: "integer", minimum: SAFE_INT_MIN },
        maximum: { type: "integer", maximum: 7 },
      },
      required: ["$schema", "minimum"],
    };
    expect(slimJsonSchema(input)).toEqual({
      type: "object",
      properties: {
        $schema: { type: "string" },
        minimum: { type: "integer" },
        maximum: { type: "integer", maximum: 7 },
      },
      required: ["$schema", "minimum"],
    });
  });

  it("does not mutate its input", () => {
    const input = {
      $schema: DRAFT_07,
      type: "object",
      properties: { n: { type: "integer", minimum: SAFE_INT_MIN } },
    };
    const before = JSON.stringify(input);
    slimJsonSchema(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("passes primitives, null and arrays through unharmed", () => {
    expect(slimJsonSchema(null)).toBeNull();
    expect(slimJsonSchema(42)).toBe(42);
    expect(slimJsonSchema("x")).toBe("x");
    expect(slimJsonSchema([{ minimum: SAFE_INT_MIN }, 1])).toEqual([{}, 1]);
  });
});

// End-to-end over a real MCP session. The wiring in with-annotations.ts reaches
// into the SDK (it intercepts the setRequestHandler call that installs the
// tools/list handler); these tests are the tripwire for that reach — if a
// future SDK routes tools/list differently the slimming silently stops, and
// this suite fails.
describe("tools/list advertises slimmed schemas", () => {
  const inputShape = {
    limit: z.number().int().max(500).optional().describe("Max rows"),
    offset: z.number().int().min(0).optional().describe("Rows to skip"),
  };

  // Real tool name so ANNOTATION_MAP / OUTPUT_SCHEMA_MAP entries resolve.
  const TOOL = "tm1_list_cubes";
  const handler = () => ({ content: [{ type: "text" as const, text: "{}" }] });

  async function listTools(server: McpServer) {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    const listing = await client.listTools();
    await client.close();
    await server.close();
    return listing;
  }

  it("strips sentinels and $schema from both input and output schemas", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const wrapped = withAnnotations(server, mockLogger, "readwrite");
    (wrapped.tool as (...a: unknown[]) => unknown)(
      TOOL,
      "list cubes",
      inputShape,
      handler,
    );

    const listing = await listTools(server);
    const tool = listing.tools.find((t) => t.name === TOOL);
    expect(tool).toBeDefined();
    expect(tool?.outputSchema).toBeDefined();

    const wire = JSON.stringify(tool);
    expect(wire).not.toContain(String(SAFE_INT_MAX));
    expect(wire).not.toContain(String(SAFE_INT_MIN));
    expect(wire).not.toContain("$schema");

    // Real bounds and the rest of the schema survive untouched.
    const props = tool?.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.limit?.maximum).toBe(500);
    expect(props.offset?.minimum).toBe(0);
    expect(props.limit?.description).toBe("Max rows");
    expect(tool?.inputSchema.type).toBe("object");
    // outputSchema is the strict one — additionalProperties must survive.
    expect(
      (tool?.outputSchema as Record<string, unknown>).additionalProperties,
    ).toBe(false);
  });

  it("control: an unwrapped server still ships the sentinels (SDK shape check)", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    server.registerTool(
      TOOL,
      { description: "list cubes", inputSchema: inputShape },
      handler,
    );

    const listing = await listTools(server);
    const wire = JSON.stringify(listing.tools.find((t) => t.name === TOOL));
    // If this ever fails, the SDK/Zod stopped emitting the noise this helper
    // exists to remove — re-check whether the slimming is still needed.
    expect(wire).toContain(String(SAFE_INT_MAX));
    expect(wire).toContain("$schema");
  });
});
