// format:"markdown" has to survive the client that discards `content`.
//
// Claude Code drops `content` whenever `structuredContent` is present (measured
// 2026-08-10), so shipping the rendered table only in `content` means the model
// never sees it. The fix puts the table INTO structuredContent as
// `{ markdown }` — which forces the declared outputSchema to accept that shape
// too, since the SDK rejects a result whose structuredContent misses required
// fields (and the client rejects extra ones).
//
// Zod unions are not an option: the SDK's zod-compat crashes on a non-object
// outputSchema and then publishes no outputSchema at all. So the SDK-facing
// schema is the loosened one, and the strict shapes are re-applied by our own
// guard in with-annotations.ts.
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type pino from "pino";
import {
  markdownCapable,
  strictVariants,
} from "../../src/tools/schemas/markdown-capable.js";
import {
  pageResponse,
  payloadResponse,
  wrappedPageResponse,
} from "../../src/tools/format.js";
import { withAnnotations } from "../../src/tools/with-annotations.js";
import {
  MARKDOWN_CAPABLE_TOOLS,
  OUTPUT_SCHEMA_MAP,
} from "../../src/tools/output-schema-map.js";

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

const PAGE = {
  total: 1,
  count: 1,
  offset: 0,
  has_more: false,
  next_offset: null,
  items: [{ name: "Sales", dimensions: ["Time", "Region"] }],
};

const RENDER = {
  title: "Cubes",
  columns: [
    { header: "Name", get: (r: { name: string }) => r.name },
    {
      header: "Dims",
      get: (r: { dimensions: string[] }) => r.dimensions.length,
    },
  ],
};

describe("markdownCapable", () => {
  const strictShape = {
    total: z.number(),
    items: z.array(z.object({ name: z.string(), dims: z.number() })),
  };
  const loose = markdownCapable(strictShape);

  it("accepts the markdown-only payload the SDK would otherwise reject", () => {
    expect(loose.safeParse({ markdown: "| a |" }).success).toBe(true);
  });

  it("still accepts the full JSON payload", () => {
    const full = { total: 1, items: [{ name: "Sales", dims: 3 }] };
    expect(loose.safeParse(full).success).toBe(true);
  });

  it("keeps nested structures strict even in the loosened schema", () => {
    // .partial() only makes TOP-LEVEL keys optional — a malformed item is
    // still caught, which is where most real drift shows up.
    const drifted = { total: 1, items: [{ name: "Sales" }] };
    expect(loose.safeParse(drifted).success).toBe(false);
  });

  it("exposes strict variants so the guard can restore top-level strictness", () => {
    const variants = strictVariants(loose);
    expect(variants).toBeDefined();
    // Missing top-level field: loose accepts it, strict must not.
    expect(loose.safeParse({ total: 1 }).success).toBe(true);
    expect(variants?.json.safeParse({ total: 1 }).success).toBe(false);
  });

  it("rejects a markdown payload that smuggles extra keys", () => {
    const variants = strictVariants(loose);
    expect(
      variants?.markdown.safeParse({ markdown: "| a |", total: 1 }).success,
    ).toBe(false);
    expect(variants?.markdown.safeParse({ markdown: "| a |" }).success).toBe(
      true,
    );
  });

  it("returns undefined for a schema that was never wrapped", () => {
    expect(strictVariants(z.object(strictShape))).toBeUndefined();
  });
});

describe("response helpers in markdown mode", () => {
  it("pageResponse puts the rendered table in structuredContent", () => {
    const res = pageResponse(PAGE, "markdown", RENDER);
    const text = res.content[0]?.text ?? "";
    expect(text).toContain("| Name |");
    expect(res.structuredContent).toEqual({ markdown: text });
  });

  it("wrappedPageResponse ships the table, not the wrapper object", () => {
    const res = wrappedPageResponse(
      { path: "/x", ...PAGE },
      PAGE,
      "markdown",
      RENDER,
    );
    const text = res.content[0]?.text ?? "";
    expect(res.structuredContent).toEqual({ markdown: text });
  });

  it("payloadResponse ships the table, not the payload", () => {
    const res = payloadResponse({ a: 1 }, "markdown", () => "## Title");
    expect(res.structuredContent).toEqual({ markdown: "## Title" });
  });

  it("leaves the JSON path untouched", () => {
    const res = pageResponse(PAGE, "json", RENDER);
    expect(res.structuredContent).toBeUndefined();
    expect(JSON.parse(res.content[0]?.text ?? "{}")).toEqual(PAGE);
  });
});

describe("end-to-end over the SDK", () => {
  async function callTool(result: unknown) {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    const wrapped = withAnnotations(server, mockLogger, "readwrite");
    (wrapped.tool as (...a: unknown[]) => unknown)(
      "tm1_list_cubes",
      "list cubes",
      {},
      () => result,
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0.0.0" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    const res = await client.callTool({
      name: "tm1_list_cubes",
      arguments: {},
    });
    await client.close();
    await server.close();
    return res as {
      content?: Array<{ text?: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
  }

  it("a markdown result survives SDK output validation", async () => {
    const md = pageResponse(PAGE, "markdown", RENDER);
    const res = await callTool(md);
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.markdown).toContain("| Name |");
    // Kiro reads content, Claude Code reads structuredContent — both get it.
    expect(res.content?.[0]?.text).toContain("| Name |");
  });

  it("the JSON path keeps top-level strictness despite the loose schema", async () => {
    // `total` missing: the SDK-facing schema tolerates it, our guard must not.
    const { total: _total, ...withoutTotal } = PAGE;
    const res = await callTool({
      content: [{ type: "text", text: JSON.stringify(withoutTotal) }],
    });
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain("output schema drift");
  });

  it("a valid JSON result still passes", async () => {
    const res = await callTool(pageResponse(PAGE, "json", RENDER));
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.total).toBe(1);
  });
});

describe("OUTPUT_SCHEMA_MAP coverage", () => {
  // Which tools belong in MARKDOWN_CAPABLE_TOOLS is policed against the source
  // by scripts/check-markdown-schema-coverage.mjs. What that script cannot see
  // is whether the resulting schema actually validates a markdown response —
  // that needs the built Zod object, so it is checked here.
  it("covers a non-trivial number of tools", () => {
    expect(MARKDOWN_CAPABLE_TOOLS.size).toBeGreaterThan(30);
  });

  it.each([...MARKDOWN_CAPABLE_TOOLS])(
    "%s accepts a markdown-only payload",
    (tool) => {
      const entry = OUTPUT_SCHEMA_MAP[tool];
      expect(entry, `${tool} has no output schema`).toBeDefined();
      expect(
        strictVariants(entry as object),
        `${tool} is not wrapped in markdownCapable()`,
      ).toBeDefined();
      expect(
        (entry as z.ZodTypeAny).safeParse({ markdown: "| a |" }).success,
        `${tool} rejects { markdown }`,
      ).toBe(true);
    },
  );
});
