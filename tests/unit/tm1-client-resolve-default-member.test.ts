import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TM1Client } from "../../src/tm1-client.js";
import { SessionManager } from "../../src/session-manager.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";
import type { TM1Config } from "../../src/config.js";

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
} as unknown as import("pino").Logger;

function makeConfig(): TM1Config {
  return {
    baseUrl: "https://tm1server:8010",
    user: "admin",
    password: "secret",
    ssl: { rejectUnauthorized: true },
    keepAliveIntervalMs: 60000,
    requestTimeoutMs: 5000,
    logLevel: "info",
  };
}

function ok(body?: unknown): Response {
  const bodyText = body !== undefined ? JSON.stringify(body) : "";
  return {
    ok: true,
    status: body === undefined ? 204 : 200,
    statusText: "OK",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(bodyText),
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function notFound(): Response {
  return {
    ok: false,
    status: 404,
    statusText: "Not Found",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(JSON.stringify({ error: { message: { value: "Not found" } } })),
  } as unknown as Response;
}

describe("DimensionService.resolveDefaultMember", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let client: TM1Client;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const config = makeConfig();
    const sm = new SessionManager(config, mockLogger);
    vi.spyOn(sm, "ensureSession").mockResolvedValue("s");
    vi.spyOn(sm, "authenticate").mockResolvedValue("s");
    vi.spyOn(sm, "startKeepAlive").mockImplementation(() => {});
    vi.spyOn(sm, "stopKeepAlive").mockImplementation(() => {});
    client = new TM1Client(config, sm, mockLogger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("Tier 1: returns source=defined when DefaultMember attribute is set", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ Name: "All Periods", Level: 4 }));

    const res = await client.dimensions.resolveDefaultMember("Period");

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toContain("/DefaultMember");
    expect(res).toEqual({
      dimension: "Period",
      hierarchy: "Period",
      resolved: { name: "All Periods", level: 4 },
      source: "defined",
      confidence: "high",
    });
  });

  it("Tier 1: defaults hierarchyName to dimensionName when omitted", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ Name: "Total", Level: 2 }));

    await client.dimensions.resolveDefaultMember("Region");

    const url = fetchSpy.mock.calls[0][0];
    expect(url).toContain("Dimensions('Region')/Hierarchies('Region')/DefaultMember");
  });

  it("Tier 1: respects explicit hierarchyName parameter", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ Name: "Top", Level: 3 }));

    await client.dimensions.resolveDefaultMember("Region", "Reporting");

    const url = fetchSpy.mock.calls[0][0];
    expect(url).toContain("Hierarchies('Reporting')/DefaultMember");
  });

  it("Tier 2 (single root): falls through 404 DefaultMember, returns unique parentless root, medium confidence (derived, not maintained)", async () => {
    fetchSpy.mockResolvedValueOnce(notFound());
    fetchSpy.mockResolvedValueOnce(
      ok({
        value: [
          { Name: "Total", Level: 3, Parents: [] },
          { Name: "Europe", Level: 2, Parents: [{ Name: "Total" }] },
          { Name: "Germany", Level: 0, Parents: [{ Name: "Europe" }] },
        ],
      }),
    );

    const res = await client.dimensions.resolveDefaultMember("Region");

    expect(res.source).toBe("single_root");
    // D6: a server-derived fallback must NOT claim tier-1 (high) confidence;
    // high is reserved for the explicitly maintained DefaultMember attribute.
    expect(res.confidence).toBe("medium");
    expect(res.resolved).toEqual({ name: "Total", level: 3 });
    expect(res.warning).toMatch(/not maintained/);
  });

  it("D6: only the maintained DefaultMember attribute (source=defined) earns high confidence", async () => {
    // Maintained default → high.
    fetchSpy.mockResolvedValueOnce(ok({ Name: "All Periods", Level: 4 }));
    const maintained = await client.dimensions.resolveDefaultMember("Period");
    expect(maintained.source).toBe("defined");
    expect(maintained.confidence).toBe("high");

    // Server-fallback default (unique root) → downgraded, never high.
    fetchSpy.mockResolvedValueOnce(notFound());
    fetchSpy.mockResolvedValueOnce(
      ok({ value: [{ Name: "Total", Level: 3, Parents: [] }] }),
    );
    const fallback = await client.dimensions.resolveDefaultMember("Region");
    expect(fallback.source).toBe("single_root");
    expect(fallback.confidence).not.toBe("high");
  });

  it("Tier 2 (single root): also falls through 204 empty DefaultMember", async () => {
    fetchSpy.mockResolvedValueOnce(ok(undefined));
    fetchSpy.mockResolvedValueOnce(
      ok({
        value: [{ Name: "All", Level: 5, Parents: [] }, { Name: "Sub", Level: 0, Parents: [{ Name: "All" }] }],
      }),
    );

    const res = await client.dimensions.resolveDefaultMember("Period");

    expect(res.source).toBe("single_root");
    expect(res.resolved.name).toBe("All");
  });

  it("Tier 2 (multiple roots): returns first_root with medium confidence and full alternatives", async () => {
    fetchSpy.mockResolvedValueOnce(notFound());
    fetchSpy.mockResolvedValueOnce(
      ok({
        value: [
          { Name: "Discontinued", Level: 2, Parents: [] },
          { Name: "Active Products", Level: 3, Parents: [] },
          { Name: "ProdA", Level: 0, Parents: [{ Name: "Active Products" }] },
        ],
      }),
    );

    const res = await client.dimensions.resolveDefaultMember("Product");

    expect(res.source).toBe("first_root");
    expect(res.confidence).toBe("medium");
    expect(res.resolved).toEqual({ name: "Active Products", level: 3 });
    expect(res.alternatives?.roots).toEqual([
      { name: "Active Products", level: 3 },
      { name: "Discontinued", level: 2 },
    ]);
    expect(res.alternatives?.indexOne).toBe("Discontinued");
    expect(res.warning).toMatch(/2 parentless roots/);
  });

  it("Tier 3 (no roots, flat dim): falls back to insertion-order index 1 with low confidence", async () => {
    fetchSpy.mockResolvedValueOnce(notFound());
    fetchSpy.mockResolvedValueOnce(
      ok({
        value: [
          { Name: "Jan", Level: 0, Parents: [{ Name: "Q1" }] },
          { Name: "Feb", Level: 0, Parents: [{ Name: "Q1" }] },
        ],
      }),
    );

    const res = await client.dimensions.resolveDefaultMember("Month");

    expect(res.source).toBe("index_1");
    expect(res.confidence).toBe("low");
    expect(res.resolved.name).toBe("Jan");
    expect(res.alternatives?.indexOne).toBe("Jan");
    expect(res.warning).toMatch(/cyclic/);
  });

  it("throws NOT_FOUND when hierarchy returns no elements after fallback", async () => {
    fetchSpy.mockResolvedValueOnce(notFound());
    fetchSpy.mockResolvedValueOnce(ok({ value: [] }));

    await expect(
      client.dimensions.resolveDefaultMember("Empty"),
    ).rejects.toMatchObject({ code: TM1ErrorCode.NOT_FOUND });
  });

  it("propagates non-404 errors from DefaultMember fetch", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Server Error",
      headers: new Headers(),
      text: vi.fn().mockResolvedValue(""),
    } as unknown as Response);

    await expect(
      client.dimensions.resolveDefaultMember("Region"),
    ).rejects.toBeInstanceOf(TM1Error);
  });

  it("encodes special characters in dimension and hierarchy names", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ Name: "X", Level: 1 }));

    await client.dimensions.resolveDefaultMember("My Dim", "My Hier");

    const url = fetchSpy.mock.calls[0][0];
    expect(url).toContain("Dimensions('My%20Dim')");
    expect(url).toContain("Hierarchies('My%20Hier')");
  });
});
