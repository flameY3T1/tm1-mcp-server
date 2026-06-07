import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TM1Client } from "../../src/tm1-client.js";
import { SessionManager } from "../../src/session-manager.js";
import type { TM1Config } from "../../src/config.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function mockResponse(body: unknown): Response {
  const bodyText = JSON.stringify(body);
  return {
    ok: true,
    status: 201,
    statusText: "Created",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(bodyText),
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TM1Client – createNative()", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let client: TM1Client;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const config = makeConfig();
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

  it("POSTs a NativeView with a registered-subset bind on an axis", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({}));

    await client.views.createNative("Sales", "MyView", {
      columns: [{ dimension: "Time", subset: "All Months" }],
      rows: [{ dimension: "Region", subset: "All Regions" }],
    });

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(decodeURIComponent(String(url))).toContain("/api/v1/Cubes('Sales')/Views");
    expect(opts.method).toBe("POST");

    const body = JSON.parse(opts.body);
    expect(body["@odata.type"]).toBe("#ibm.tm1.api.v1.NativeView");
    expect(body.Name).toBe("MyView");
    expect(body.Columns[0]["Subset@odata.bind"]).toBe(
      "Dimensions('Time')/Hierarchies('Time')/Subsets('All Months')",
    );
    expect(body.Rows[0]["Subset@odata.bind"]).toBe(
      "Dimensions('Region')/Hierarchies('Region')/Subsets('All Regions')",
    );
    // Defaults: no suppression, no FormatString unless requested.
    expect(body.SuppressEmptyColumns).toBe(false);
    expect(body.SuppressEmptyRows).toBe(false);
    expect(body.FormatString).toBeUndefined();
  });

  it("builds anonymous subsets from explicit element lists", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({}));

    await client.views.createNative("Sales", "MyView", {
      columns: [{ dimension: "Time", elements: ["Jan", "Feb"] }],
      rows: [{ dimension: "Region", hierarchy: "ByGeo", elements: ["West"] }],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.Columns[0].Subset["Hierarchy@odata.bind"]).toBe(
      "Dimensions('Time')/Hierarchies('Time')",
    );
    expect(body.Columns[0].Subset["Elements@odata.bind"]).toEqual([
      "Dimensions('Time')/Hierarchies('Time')/Elements('Jan')",
      "Dimensions('Time')/Hierarchies('Time')/Elements('Feb')",
    ]);
    // Explicit hierarchy overrides the dimension default.
    expect(body.Rows[0].Subset["Hierarchy@odata.bind"]).toBe(
      "Dimensions('Region')/Hierarchies('ByGeo')",
    );
  });

  it("builds anonymous subsets from an MDX expression", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({}));

    await client.views.createNative("Sales", "MyView", {
      columns: [{ dimension: "Time", expression: "{TM1SUBSETALL([Time])}" }],
      rows: [{ dimension: "Region", subset: "All Regions" }],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.Columns[0].Subset["Hierarchy@odata.bind"]).toBe(
      "Dimensions('Time')/Hierarchies('Time')",
    );
    expect(body.Columns[0].Subset.Expression).toBe("{TM1SUBSETALL([Time])}");
  });

  it("maps titles with a selected element and passes suppression + format", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({}));

    await client.views.createNative("Sales", "MyView", {
      columns: [{ dimension: "Time", subset: "All Months" }],
      rows: [{ dimension: "Region", subset: "All Regions" }],
      titles: [{ dimension: "Version", elements: ["Actual"], selected: "Actual" }],
      suppressEmptyColumns: true,
      suppressEmptyRows: true,
      formatString: "0.#########",
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.Titles[0].Subset["Elements@odata.bind"]).toEqual([
      "Dimensions('Version')/Hierarchies('Version')/Elements('Actual')",
    ]);
    expect(body.Titles[0]["Selected@odata.bind"]).toBe(
      "Dimensions('Version')/Hierarchies('Version')/Elements('Actual')",
    );
    expect(body.SuppressEmptyColumns).toBe(true);
    expect(body.SuppressEmptyRows).toBe(true);
    expect(body.FormatString).toBe("0.#########");
  });

  it("getDefinition expands native axes in path form (11.8 rejects parenthesized options on complex collections)", async () => {
    // 1st request: base view (no MDX → native). 2nd request: tm1.NativeView expand.
    fetchSpy
      .mockResolvedValueOnce(mockResponse({ Name: "NV", MDX: null }))
      .mockResolvedValueOnce(
        mockResponse({
          Titles: [
            {
              Subset: { Name: "", Expression: "{TM1SUBSETALL([Version])}", Hierarchy: { Name: "Version", Dimension: { Name: "Version" } } },
              Selected: { Name: "Actual" },
            },
          ],
          Columns: [
            { Subset: { Name: "All Months", Hierarchy: { Name: "Time", Dimension: { Name: "Time" } } } },
          ],
          Rows: [
            { Subset: { Name: "All Regions", Hierarchy: { Name: "Region", Dimension: { Name: "Region" } } } },
          ],
        }),
      );

    const def = await client.views.getDefinition("Sales", "NV", false);

    const nativeUrl = decodeURIComponent(String(fetchSpy.mock.calls[1][0]));
    // Path through the complex collection, parenthesized options only from the
    // entity (Subset) on — TM1 11.8 rejects Titles($expand=...) and pure path
    // form beyond the entity (live-verified).
    expect(nativeUrl).not.toContain("Titles($expand");
    expect(nativeUrl).not.toContain("Columns($expand");
    expect(nativeUrl).not.toContain("Rows($expand");
    expect(nativeUrl).toContain("Titles/Subset($expand=Hierarchy($expand=Dimension))");
    expect(nativeUrl).toContain("Titles/Selected");
    expect(nativeUrl).toContain("Columns/Subset($expand=Hierarchy($expand=Dimension))");
    expect(nativeUrl).toContain("Rows/Subset($expand=Hierarchy($expand=Dimension))");

    expect(def.type).toBe("Native");
    expect(def.native?.columns[0]).toEqual({
      dimensionName: "Time",
      hierarchyName: "Time",
      subsetName: "All Months",
      expression: undefined,
    });
    expect(def.native?.titles[0]).toEqual({
      dimensionName: "Version",
      hierarchyName: "Version",
      subsetName: undefined,
      expression: "{TM1SUBSETALL([Version])}",
      selectedElement: "Actual",
    });
  });

  it("rejects a title spec without a selected element (TM1 400s otherwise)", async () => {
    await expect(
      client.views.createNative("Sales", "Bad", {
        columns: [{ dimension: "Time", subset: "All Months" }],
        rows: [{ dimension: "Region", subset: "All Regions" }],
        titles: [{ dimension: "Version", elements: ["Actual"] }],
      }),
    ).rejects.toThrow(/selected/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an axis spec without exactly one of subset/expression/elements", async () => {
    await expect(
      client.views.createNative("Sales", "Bad", {
        columns: [{ dimension: "Time" }],
        rows: [{ dimension: "Region", subset: "All Regions" }],
      }),
    ).rejects.toThrow(/exactly one of/i);

    await expect(
      client.views.createNative("Sales", "Bad", {
        columns: [{ dimension: "Time", subset: "S", expression: "{[Time].[Jan]}" }],
        rows: [{ dimension: "Region", subset: "All Regions" }],
      }),
    ).rejects.toThrow(/exactly one of/i);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
