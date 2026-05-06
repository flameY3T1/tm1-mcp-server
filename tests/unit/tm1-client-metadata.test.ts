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
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(bodyText),
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TM1Client – Metadata Methods", () => {
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

  // ── getCubes() ─────────────────────────────────────────────────────────────

  describe("getCubes()", () => {
    it("should return cubes with name and dimension names", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [
            { Name: "SalesCube", Dimensions: [{ Name: "Region" }, { Name: "Product" }, { Name: "Time" }] },
            { Name: "PlanCube", Dimensions: [{ Name: "Account" }, { Name: "Time" }] },
          ],
        }),
      );

      const cubes = await client.getCubes();

      expect(cubes).toEqual([
        { name: "SalesCube", dimensions: ["Region", "Product", "Time"] },
        { name: "PlanCube", dimensions: ["Account", "Time"] },
      ]);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Cubes?$expand=Dimensions($select=Name)");
    });

    it("should return empty array when no cubes exist", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ value: [] }));

      const cubes = await client.getCubes();
      expect(cubes).toEqual([]);
    });
  });

  // ── getDimensions() ────────────────────────────────────────────────────────

  describe("getDimensions()", () => {
    it("should return dimensions with name and hierarchy names", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [
            { Name: "Region", Hierarchies: [{ Name: "Region" }, { Name: "Country" }] },
            { Name: "Time", Hierarchies: [{ Name: "Time" }] },
          ],
        }),
      );

      const dims = await client.getDimensions();

      expect(dims).toEqual([
        { name: "Region", hierarchies: ["Region", "Country"] },
        { name: "Time", hierarchies: ["Time"] },
      ]);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Dimensions?$expand=Hierarchies($select=Name)");
    });

    it("should return empty array when no dimensions exist", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ value: [] }));

      const dims = await client.getDimensions();
      expect(dims).toEqual([]);
    });
  });

  // ── getHierarchy() ─────────────────────────────────────────────────────────

  describe("getHierarchy()", () => {
    it("should return hierarchy with elements, parents and children", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          Name: "Region",
          Elements: [
            {
              Name: "Europe",
              Type: "Consolidated",
              Level: 1,
              Parents: [],
              Children: [{ Name: "Germany", Weight: 1 }, { Name: "France", Weight: 1 }],
            },
            {
              Name: "Germany",
              Type: "Numeric",
              Level: 0,
              Parents: [{ Name: "Europe" }],
              Children: [],
            },
            {
              Name: "France",
              Type: "Numeric",
              Level: 0,
              Parents: [{ Name: "Europe" }],
              Children: [],
            },
          ],
        }),
      );

      const hierarchy = await client.getHierarchy("Region", "Region");

      expect(hierarchy.name).toBe("Region");
      expect(hierarchy.dimensionName).toBe("Region");
      expect(hierarchy.elements).toHaveLength(3);

      const europe = hierarchy.elements[0];
      expect(europe.name).toBe("Europe");
      expect(europe.type).toBe("Consolidated");
      expect(europe.level).toBe(1);
      expect(europe.parents).toEqual([]);
      expect(europe.children).toEqual([
        { name: "Germany", weight: 1 },
        { name: "France", weight: 1 },
      ]);

      const germany = hierarchy.elements[1];
      expect(germany.parents).toEqual(["Europe"]);
      expect(germany.children).toEqual([]);
    });

    it("should handle elements without Parents/Children arrays", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          Name: "Measures",
          Elements: [
            { Name: "Amount", Type: "Numeric", Level: 0 },
          ],
        }),
      );

      const hierarchy = await client.getHierarchy("Measures", "Measures");

      expect(hierarchy.elements[0].parents).toEqual([]);
      expect(hierarchy.elements[0].children).toEqual([]);
    });

    it("should encode special characters in dimension/hierarchy names", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ Name: "My Dim", Elements: [] }),
      );

      await client.getHierarchy("My Dim", "My Hier");

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("Dimensions('My%20Dim')");
      expect(url).toContain("Hierarchies('My%20Hier')");
    });

    it("should push nameContains to OData $filter as contains()", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ Name: "Region", Elements: [] }));
      await client.getHierarchy("Region", "Region", { nameContains: "DE" });
      const [url] = fetchSpy.mock.calls[0];
      expect(decodeURIComponent(url as string)).toContain("contains(Name, 'DE')");
    });

    it("should push nameStartsWith to OData $filter as startswith()", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ Name: "Region", Elements: [] }));
      await client.getHierarchy("Region", "Region", { nameStartsWith: "FY24_" });
      const [url] = fetchSpy.mock.calls[0];
      expect(decodeURIComponent(url as string)).toContain("startswith(Name, 'FY24_')");
    });

    it("should escape single quotes in OData name filters", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ Name: "Region", Elements: [] }));
      await client.getHierarchy("Region", "Region", { nameContains: "Foo's" });
      const [url] = fetchSpy.mock.calls[0];
      expect(decodeURIComponent(url as string)).toContain("contains(Name, 'Foo''s')");
    });

    it("should apply nameRegex client-side and prune dangling parents", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          Name: "Region",
          Elements: [
            { Name: "Europe", Type: "Consolidated", Level: 1, Parents: [] },
            { Name: "DE_Bayern", Type: "Numeric", Level: 0, Parents: [{ Name: "Europe" }] },
            { Name: "FR_Paris", Type: "Numeric", Level: 0, Parents: [{ Name: "Europe" }] },
          ],
        }),
      );
      const hierarchy = await client.getHierarchy("Region", "Region", { nameRegex: "^DE_" });
      expect(hierarchy.elements).toHaveLength(1);
      expect(hierarchy.elements[0].name).toBe("DE_Bayern");
      expect(hierarchy.elements[0].parents).toEqual([]);
    });

    it("should not push nameRegex to OData (client-side only)", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ Name: "Region", Elements: [] }));
      await client.getHierarchy("Region", "Region", { nameRegex: "^X" });
      const [url] = fetchSpy.mock.calls[0];
      expect(decodeURIComponent(url as string)).not.toContain("$filter");
    });

    it("should move $top client-side when nameRegex set", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          Name: "Region",
          Elements: [
            { Name: "DE_1", Type: "Numeric", Level: 0 },
            { Name: "DE_2", Type: "Numeric", Level: 0 },
            { Name: "DE_3", Type: "Numeric", Level: 0 },
            { Name: "FR_1", Type: "Numeric", Level: 0 },
          ],
        }),
      );
      const hierarchy = await client.getHierarchy("Region", "Region", { nameRegex: "^DE_", topN: 2 });
      const [url] = fetchSpy.mock.calls[0];
      expect(decodeURIComponent(url as string)).not.toContain("$top");
      expect(hierarchy.elements).toHaveLength(2);
      expect(hierarchy.elements.map((e) => e.name)).toEqual(["DE_1", "DE_2"]);
    });

    it("should throw VALIDATION_ERROR on invalid nameRegex", async () => {
      await expect(
        client.getHierarchy("Region", "Region", { nameRegex: "[unclosed" }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    it("should combine server-side name filter with level filter via AND", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ Name: "Region", Elements: [] }));
      await client.getHierarchy("Region", "Region", { nameStartsWith: "DE_", levelMax: 1 });
      const [url] = fetchSpy.mock.calls[0];
      const decoded = decodeURIComponent(url as string);
      expect(decoded).toContain("Level le 1");
      expect(decoded).toContain("startswith(Name, 'DE_')");
      expect(decoded).toContain(" and ");
    });
  });

  // ── getProcesses() ─────────────────────────────────────────────────────────

  describe("getProcesses()", () => {
    it("should return processes with mapped parameters", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [
            {
              Name: "ImportData",
              Parameters: [
                { Name: "pFilePath", Type: "String", Value: "/data/input.csv", Prompt: "File path" },
                { Name: "pYear", Type: "Numeric", Value: 2024 },
              ],
            },
            {
              Name: "ExportReport",
              Parameters: [],
            },
          ],
        }),
      );

      const processes = await client.getProcesses();

      expect(processes).toEqual([
        {
          name: "ImportData",
          parameters: [
            { name: "pFilePath", type: "String", defaultValue: "/data/input.csv", prompt: "File path" },
            { name: "pYear", type: "Numeric", defaultValue: 2024 },
          ],
        },
        {
          name: "ExportReport",
          parameters: [],
        },
      ]);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Processes?$select=Name,Parameters");
    });

    it("should map Type 'Numeric' / 'String' from TM1 v11 API", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [
            {
              Name: "TestProc",
              Parameters: [
                { Name: "numParam", Type: "Numeric", Value: 42 },
                { Name: "strParam", Type: "String", Value: "hello" },
              ],
            },
          ],
        }),
      );

      const processes = await client.getProcesses();
      expect(processes[0].parameters[0].type).toBe("Numeric");
      expect(processes[0].parameters[1].type).toBe("String");
    });

    it("should return empty array when no processes exist", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ value: [] }));

      const processes = await client.getProcesses();
      expect(processes).toEqual([]);
    });
  });

  // ── getChores() ────────────────────────────────────────────────────────────

  describe("getChores()", () => {
    it("should return chores with tasks mapped to processes", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [
            {
              Name: "NightlyImport",
              Active: true,
              StartTime: "2024-01-01T02:00:00",
              DSTSensitive: false,
              Frequency: "P1D",
              Tasks: [
                {
                  Process: { Name: "ImportData" },
                  Parameters: [
                    { Name: "pFilePath", Value: "/data/nightly.csv" },
                    { Name: "pYear", Value: 2024 },
                  ],
                },
                {
                  Process: { Name: "RunCalc" },
                  Parameters: [],
                },
              ],
            },
          ],
        }),
      );

      const chores = await client.getChores();

      expect(chores).toEqual([
        {
          name: "NightlyImport",
          active: true,
          startTime: "2024-01-01T02:00:00",
          frequency: "P1D",
          processes: [
            { name: "ImportData", parameters: { pFilePath: "/data/nightly.csv", pYear: 2024 } },
            { name: "RunCalc", parameters: {} },
          ],
        },
      ]);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Chores?$expand=Tasks");
    });

    it("should return empty array when no chores exist", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ value: [] }));

      const chores = await client.getChores();
      expect(chores).toEqual([]);
    });

    it("should handle chore with no tasks", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [
            {
              Name: "EmptyChore",
              Active: false,
              StartTime: "2024-06-01T00:00:00",
              DSTSensitive: true,
              Frequency: "P7D",
              Tasks: [],
            },
          ],
        }),
      );

      const chores = await client.getChores();
      expect(chores[0].processes).toEqual([]);
      expect(chores[0].active).toBe(false);
    });
  });
});
