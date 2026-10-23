import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import type pino from "pino";
import type { FnSpy } from "../helpers/spy-types.js";
import { TM1Client } from "../../src/tm1-client.js";
import { SessionManager } from "../../src/session-manager.js";
import type { TM1Config } from "../../src/config.js";
import { registerSearchElements } from "../../src/tools/metadata/search-elements.js";

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

function mockResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

// OData cannot filter on attribute values (v11 error 278), so the search is
// an MDX FILTER over the name and every String/Alias attribute.
describe("ElementService.searchElements", () => {
  let fetchSpy: FnSpy;
  let client: TM1Client;

  beforeEach(() => {
    fetchSpy = vi.fn();
    stubContractCheckedFetch(fetchSpy);
    const config = {
      baseUrl: "https://tm1server:8010",
      user: "admin",
      password: "secret",
      ssl: { rejectUnauthorized: true },
      keepAliveIntervalMs: 60_000,
      requestTimeoutMs: 5_000,
      logLevel: "info",
    } as unknown as TM1Config;
    const sessionManager = new SessionManager(config, mockLogger);
    vi.spyOn(sessionManager, "ensureSession").mockResolvedValue("session123");
    vi.spyOn(sessionManager, "authenticate").mockResolvedValue("session123");
    vi.spyOn(sessionManager, "startKeepAlive").mockImplementation(() => {});
    vi.spyOn(sessionManager, "stopKeepAlive").mockImplementation(() => {});
    client = new TM1Client(config, sessionManager, mockLogger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("filters on name and text attributes, escapes, and reports the matching attribute", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        value: [
          { Name: "Site", Type: "String" },
          { Name: "Weight", Type: "Numeric" },
          { Name: "Short", Type: "Alias" },
        ],
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        Cardinality: 7,
        Tuples: [
          {
            Members: [
              {
                Name: "North_Ab",
                Attributes: {},
                Element: { Type: "Numeric", Level: 0 },
              },
            ],
          },
          {
            Members: [
              {
                Name: "K17",
                Attributes: { Site: "Ab Ville" },
                Element: { Type: "Consolidated", Level: 1 },
              },
            ],
          },
        ],
      }),
    );

    const r = await client.elements.searchElements(
      "Reg]ion",
      "Reg]ion",
      'A"b',
      2,
      ["Site", "Weight", "Missing"],
    );

    const mdx = (
      JSON.parse(
        String((fetchSpy.mock.calls[1][1] as { body: string }).body),
      ) as {
        MDX: string;
      }
    ).MDX;
    expect(mdx).toContain("TM1SUBSETALL([Reg]]ion].[Reg]]ion])");
    expect(mdx).toContain('Properties("Site")');
    expect(mdx).toContain('Properties("Short")');
    expect(mdx).not.toContain("Weight");
    expect(mdx).toContain('"a""b"');
    expect(String(fetchSpy.mock.calls[1][0])).toContain("Tuples($top=2;");

    expect(r.total).toBe(7);
    expect(r.elements.map((m) => m.name)).toEqual(["North_Ab", "K17"]);
  });

  it("searches Alias attributes only unless String attributes are named", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        value: [
          { Name: "Site", Type: "String" },
          { Name: "Short", Type: "Alias" },
        ],
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ Cardinality: 0, Tuples: [] }),
    );
    await client.elements.searchElements("Region", "Region", "x", 10);
    const mdx = (
      JSON.parse(
        String((fetchSpy.mock.calls[1][1] as { body: string }).body),
      ) as {
        MDX: string;
      }
    ).MDX;
    expect(mdx).toContain('Properties("Short")');
    expect(mdx).not.toContain("Site");
  });

  it("names the attribute that matched", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ value: [{ Name: "Site", Type: "String" }] }),
    );
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        Cardinality: 2,
        Tuples: [
          {
            Members: [
              {
                Name: "North_Ab",
                Attributes: {},
                Element: { Type: "Numeric", Level: 0 },
              },
            ],
          },
          {
            Members: [
              {
                Name: "K17",
                Attributes: { Site: "Ab Ville" },
                Element: { Type: "Consolidated", Level: 1 },
              },
            ],
          },
        ],
      }),
    );
    const r = await client.elements.searchElements(
      "Region",
      "Region",
      "AB",
      10,
      ["Site"],
    );
    expect(r.elements).toEqual([
      {
        name: "North_Ab",
        type: "Numeric",
        level: 0,
        matchedOn: "Name",
        matchedValue: "North_Ab",
      },
      {
        name: "K17",
        type: "Consolidated",
        level: 1,
        matchedOn: "Site",
        matchedValue: "Ab Ville",
      },
    ]);
  });
});

describe("tm1_search_elements tool", () => {
  type Handler = (args: Record<string, unknown>) => Promise<unknown>;

  function setup(results: Record<string, { total: number; names: string[] }>) {
    let handler: Handler | null = null;
    let schema: Record<string, z.ZodTypeAny> = {};
    const server = {
      tool: (
        _name: string,
        _desc: string,
        input: Record<string, z.ZodTypeAny>,
        cb: Handler,
      ) => {
        schema = input;
        handler = cb;
      },
    };
    const searchElements = vi.fn(async (dim: string) => ({
      total: results[dim].total,
      elements: results[dim].names.map((name) => ({
        name,
        type: "Numeric",
        level: 0,
        matchedOn: "Name",
        matchedValue: name,
      })),
    }));
    const tm1 = {
      cubes: { getDimensionNames: vi.fn(async () => Object.keys(results)) },
      elements: { searchElements },
    };
    registerSearchElements(
      server as unknown as Parameters<typeof registerSearchElements>[0],
      tm1 as unknown as Parameters<typeof registerSearchElements>[1],
    );
    // Parse like the SDK does, so defaults and min(1) apply.
    const call = (args: Record<string, unknown>) =>
      handler!(z.object(schema).parse(args)).then(
        (r) =>
          JSON.parse(
            (r as { content: Array<{ text: string }> }).content[0].text,
          ) as {
            dimensions: Array<{
              dimension: string;
              total: number;
              truncated: boolean;
            }>;
          },
      );
    return { call, schema, searchElements };
  }

  it("rejects both or neither of cubeName and dimensionName", async () => {
    const { call } = setup({ Region: { total: 0, names: [] } });
    await expect(call({ searchTerm: "x" })).rejects.toThrow("exactly one");
    await expect(
      call({ searchTerm: "x", cubeName: "Sales", dimensionName: "Region" }),
    ).rejects.toThrow("exactly one");
  });

  it("rejects an empty cubeName instead of searching a dimension called undefined", () => {
    const { schema } = setup({});
    expect(() =>
      z.object(schema).parse({ searchTerm: "x", cubeName: "" }),
    ).toThrow();
  });

  it("searches every cube dimension and drops the ones without hits", async () => {
    const { call, searchElements } = setup({
      Region: { total: 3, names: ["North", "South"] },
      Product: { total: 0, names: [] },
    });
    const r = await call({ searchTerm: "o", cubeName: "Sales", topN: 2 });
    expect(searchElements).toHaveBeenCalledTimes(2);
    expect(r.dimensions).toEqual([
      expect.objectContaining({
        dimension: "Region",
        total: 3,
        truncated: true,
      }),
    ]);
  });

  it("keeps a single dimension without hits", async () => {
    const { call, searchElements } = setup({ Region: { total: 0, names: [] } });
    const r = await call({ searchTerm: "zz", dimensionName: "Region" });
    expect(searchElements).toHaveBeenCalledWith(
      "Region",
      "Region",
      "zz",
      10,
      undefined,
    );
    expect(r.dimensions).toEqual([
      expect.objectContaining({
        dimension: "Region",
        total: 0,
        truncated: false,
      }),
    ]);
  });
});
