import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TM1Client } from "../../src/tm1-client.js";
import { SessionManager } from "../../src/session-manager.js";
import { TM1Error } from "../../src/types.js";
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

describe("TM1Client – Cell Data Methods", () => {
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

  // ── getCellValue() ─────────────────────────────────────────────────────────

  describe("getCellValue()", () => {
    const salesCubeMeta = {
      Name: "SalesCube",
      Dimensions: [{ Name: "Time" }, { Name: "Region" }, { Name: "Scenario" }],
    };
    const statusCubeMeta = {
      Name: "StatusCube",
      Dimensions: [{ Name: "Time" }, { Name: "Status" }],
    };

    it("should return a numeric cell value with hierarchically qualified MDX", async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(salesCubeMeta))
        .mockResolvedValueOnce(
          mockResponse({
            ID: "cellset-001",
            Cells: [{ Value: 42.5, FormattedValue: "42.50" }],
          }),
        );

      const value = await client.cells.getValue("SalesCube", ["Jan", "Germany", "Actual"]);

      expect(value).toBe(42.5);

      const [cubeUrl, cubeOpts] = fetchSpy.mock.calls[0];
      expect(cubeUrl).toContain("/api/v1/Cubes('SalesCube')");
      expect(cubeUrl).toContain("$expand=Dimensions");
      expect(cubeOpts.method).toBe("GET");

      const [mdxUrl, mdxOpts] = fetchSpy.mock.calls[1];
      expect(mdxUrl).toContain("/api/v1/ExecuteMDX");
      expect(mdxOpts.method).toBe("POST");
      const body = JSON.parse(mdxOpts.body);
      expect(body.MDX).toBe(
        "SELECT {[Time].[Jan]} ON COLUMNS FROM [SalesCube] WHERE ([Region].[Germany],[Scenario].[Actual])",
      );
    });

    it("should return a string cell value", async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(statusCubeMeta))
        .mockResolvedValueOnce(
          mockResponse({
            ID: "cellset-002",
            Cells: [{ Value: "Active", FormattedValue: "Active" }],
          }),
        );

      const value = await client.cells.getValue("StatusCube", ["Q1", "Open"]);
      expect(value).toBe("Active");
    });

    it("should return null when cell is empty", async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(salesCubeMeta))
        .mockResolvedValueOnce(
          mockResponse({
            ID: "cellset-003",
            Cells: [{ Value: null, FormattedValue: "" }],
          }),
        );

      const value = await client.cells.getValue("SalesCube", ["Feb", "France", "Budget"]);
      expect(value).toBeNull();
    });

    it("should return null when Cells array is empty", async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(salesCubeMeta))
        .mockResolvedValueOnce(mockResponse({ ID: "cellset-004", Cells: [] }));

      const value = await client.cells.getValue("SalesCube", ["Mar", "UK", "Actual"]);
      expect(value).toBeNull();
    });

    it("should return null when Cells is missing from response", async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(salesCubeMeta))
        .mockResolvedValueOnce(mockResponse({ ID: "cellset-005" }));

      const value = await client.cells.getValue("SalesCube", ["Apr", "US", "Actual"]);
      expect(value).toBeNull();
    });

    it("should pass through pre-qualified `[Dim].[Element]` element strings", async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(salesCubeMeta))
        .mockResolvedValueOnce(
          mockResponse({ ID: "cellset-006", Cells: [{ Value: 1, FormattedValue: "1" }] }),
        );

      await client.cells.getValue("SalesCube", [
        "[Time].[Jan]",
        "[Region].[Germany]",
        "[Scenario].[Actual]",
      ]);

      const body = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(body.MDX).toBe(
        "SELECT {[Time].[Jan]} ON COLUMNS FROM [SalesCube] WHERE ([Region].[Germany],[Scenario].[Actual])",
      );
    });

    it("D1: doubles `]` in bracketed identifiers (MDX injection / mis-addressing)", async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(salesCubeMeta))
        .mockResolvedValueOnce(
          mockResponse({ ID: "cellset-d1", Cells: [{ Value: 1, FormattedValue: "1" }] }),
        );

      await client.cells.getValue("SalesCube", ["Q4]Adj", "Germany", "Actual"]);

      const body = JSON.parse(fetchSpy.mock.calls[1][1].body);
      // `]` inside a name must be doubled so it can't terminate the identifier.
      expect(body.MDX).toContain("[Time].[Q4]]Adj]");
      expect(body.MDX).not.toContain("[Time].[Q4]Adj]");
    });

    it("should throw on dimension/element count mismatch", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(salesCubeMeta));

      await expect(
        client.cells.getValue("SalesCube", ["Jan", "Germany"]),
      ).rejects.toThrow(/3 dimension\(s\).*2 element\(s\)/);
    });
  });

  // ── executeMdx() ───────────────────────────────────────────────────────────

  describe("executeMdx()", () => {
    const sampleResponse = {
      ID: "cellset-100",
      Cells: [
        { Value: 100, FormattedValue: "100.00" },
        { Value: 200, FormattedValue: "200.00" },
        { Value: 150, FormattedValue: "150.00" },
        { Value: 250, FormattedValue: "250.00" },
      ],
      Axes: [
        {
          Tuples: [
            { Members: [{ Name: "Jan", Hierarchy: { Name: "Time" } }] },
            { Members: [{ Name: "Feb", Hierarchy: { Name: "Time" } }] },
          ],
        },
        {
          Tuples: [
            { Members: [{ Name: "Germany", Hierarchy: { Name: "Region" } }] },
            { Members: [{ Name: "France", Hierarchy: { Name: "Region" } }] },
          ],
        },
      ],
    };

    it("should return structured MdxResult with cells and axes", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(sampleResponse));

      const result = await client.cells.executeMdx("SELECT {[Time].[Jan],[Time].[Feb]} ON COLUMNS, {[Region].[Germany],[Region].[France]} ON ROWS FROM [SalesCube]");

      expect(result.cells).toEqual([
        { value: 100, formattedValue: "100.00" },
        { value: 200, formattedValue: "200.00" },
        { value: 150, formattedValue: "150.00" },
        { value: 250, formattedValue: "250.00" },
      ]);

      expect(result.axes).toHaveLength(2);
      expect(result.axes[0].tuples).toHaveLength(2);
      expect(result.axes[0].tuples[0].members[0]).toEqual({ name: "Jan", hierarchyName: "Time" });
      expect(result.axes[1].tuples[1].members[0]).toEqual({ name: "France", hierarchyName: "Region" });

      // totalCellCount = 2 columns * 2 rows = 4
      expect(result.totalCellCount).toBe(4);
    });

    it("frees the server-side cellset with a DELETE after reading (H2)", async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(sampleResponse))
        .mockResolvedValueOnce(mockResponse({}));

      await client.cells.executeMdx("SELECT {} ON COLUMNS FROM [SalesCube]");

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const [delUrl, delOpts] = fetchSpy.mock.calls[1];
      expect(delOpts.method).toBe("DELETE");
      expect(delUrl).toContain("/api/v1/Cellsets('cellset-100')");
    });

    it("still returns the read result when cellset cleanup fails", async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(sampleResponse))
        .mockRejectedValueOnce(new Error("network blip on DELETE"));

      const result = await client.cells.executeMdx("SELECT {} ON COLUMNS FROM [SalesCube]");
      expect(result.totalCellCount).toBe(4);
    });

    it("should send MDX in POST body", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(sampleResponse));

      await client.cells.executeMdx("SELECT {} ON COLUMNS FROM [TestCube]");

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/ExecuteMDX");
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body.MDX).toBe("SELECT {} ON COLUMNS FROM [TestCube]");
    });

    it("should include $top in the request when provided", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ID: "cellset-101",
          Cells: [{ Value: 10, FormattedValue: "10.00" }],
          Axes: [{ Tuples: [{ Members: [{ Name: "Jan", Hierarchy: { Name: "Time" } }] }] }],
        }),
      );

      await client.cells.executeMdx("SELECT {} ON COLUMNS FROM [Cube]", 10);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("$top=10");
    });

    it("should include $skip in the request when provided", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ID: "cellset-102",
          Cells: [],
          Axes: [],
        }),
      );

      await client.cells.executeMdx("SELECT {} ON COLUMNS FROM [Cube]", undefined, 5);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("$skip=5");
      expect(url).not.toContain("$top=");
    });

    it("should include both $top and $skip when provided", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ID: "cellset-103",
          Cells: [{ Value: 1, FormattedValue: "1" }],
          Axes: [{ Tuples: [{ Members: [{ Name: "X", Hierarchy: { Name: "Dim" } }] }] }],
        }),
      );

      await client.cells.executeMdx("SELECT {} ON COLUMNS FROM [Cube]", 20, 10);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("$top=20");
      expect(url).toContain("$skip=10");
    });

    it("should handle empty result set", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ID: "cellset-104", Cells: [], Axes: [] }),
      );

      const result = await client.cells.executeMdx("SELECT {} ON COLUMNS FROM [EmptyCube]");

      expect(result.cells).toEqual([]);
      expect(result.axes).toEqual([]);
      expect(result.totalCellCount).toBe(0);
    });

    it("should use timeoutMs override when provided", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ID: "cellset-timeout", Cells: [], Axes: [] }),
      );
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");

      await client.cells.executeMdx("SELECT {} FROM [Cube]", undefined, undefined, { timeoutMs: 120000 });

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 120000);
      setTimeoutSpy.mockRestore();
    });

    it("should fall back to config requestTimeoutMs when no override", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ID: "cellset-default", Cells: [], Axes: [] }),
      );
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");

      await client.cells.executeMdx("SELECT {} FROM [Cube]");

      // makeConfig() sets requestTimeoutMs: 5000.
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
      setTimeoutSpy.mockRestore();
    });

    it("should compute totalCellCount from axes cardinality", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ID: "cellset-105",
          Cells: [
            { Value: 1, FormattedValue: "1" },
            { Value: 2, FormattedValue: "2" },
          ],
          Axes: [
            {
              Tuples: [
                { Members: [{ Name: "A", Hierarchy: { Name: "D1" } }] },
                { Members: [{ Name: "B", Hierarchy: { Name: "D1" } }] },
                { Members: [{ Name: "C", Hierarchy: { Name: "D1" } }] },
              ],
            },
            {
              Tuples: [
                { Members: [{ Name: "X", Hierarchy: { Name: "D2" } }] },
                { Members: [{ Name: "Y", Hierarchy: { Name: "D2" } }] },
              ],
            },
          ],
        }),
      );

      const result = await client.cells.executeMdx("SELECT ...", 2);

      // totalCellCount = 3 * 2 = 6, even though only 2 cells returned (paginated)
      expect(result.totalCellCount).toBe(6);
      expect(result.cells).toHaveLength(2);
    });

    it("should handle multi-member tuples", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ID: "cellset-106",
          Cells: [{ Value: 99, FormattedValue: "99" }],
          Axes: [
            {
              Tuples: [
                {
                  Members: [
                    { Name: "Jan", Hierarchy: { Name: "Time" } },
                    { Name: "Actual", Hierarchy: { Name: "Version" } },
                  ],
                },
              ],
            },
          ],
        }),
      );

      const result = await client.cells.executeMdx("SELECT ...");

      expect(result.axes[0].tuples[0].members).toHaveLength(2);
      expect(result.axes[0].tuples[0].members[0]).toEqual({ name: "Jan", hierarchyName: "Time" });
      expect(result.axes[0].tuples[0].members[1]).toEqual({ name: "Actual", hierarchyName: "Version" });
    });
  });

  // ── writeCells() partial-commit reporting (M4) ──────────────────────────────

  describe("writeCells() partial commit", () => {
    // Route by URL/body so one specific cell's PATCH fails while the rest
    // succeed. Each cell = ExecuteMDX (→ cellset id) + PATCH Cells(0) + DELETE.
    function routeWithBadCell(): void {
      fetchSpy.mockImplementation((url: unknown, init: unknown) => {
        const u = String(url);
        const opts = init as { method: string; body?: string };
        if (u.includes("/ExecuteMDX")) {
          const mdx = JSON.parse(opts.body ?? "{}").MDX as string;
          const id = mdx.includes("[Dim1].[Dim1].[BAD]") ? "bad" : "good";
          return Promise.resolve(mockResponse({ ID: id }));
        }
        if (u.includes("/Cells(0)")) {
          if (u.includes("Cellsets('bad')")) {
            return Promise.resolve({
              ok: false,
              status: 400,
              statusText: "Bad Request",
              headers: new Headers(),
              text: vi
                .fn()
                .mockResolvedValue(JSON.stringify({ error: { message: "consolidated cell" } })),
            } as unknown as Response);
          }
          return Promise.resolve(mockResponse({}));
        }
        // DELETE cleanup
        return Promise.resolve(mockResponse({}));
      });
    }

    it("throws with written/failed/notAttempted split and stops after the failing batch", async () => {
      routeWithBadCell();

      // 12 cells → two batches (BATCH_SIZE 10). The failing cell sits in batch 1,
      // so batch 2 (indices 10–11) must never be attempted.
      const dimensions = ["Dim1", "Dim2"];
      const cells = Array.from({ length: 12 }, (_, i) => ({
        elements: [`E${i}`, "M"],
        value: i,
      }));
      cells[3] = { elements: ["BAD", "M"], value: 3 };

      let caught: unknown;
      try {
        await client.cells.writeCells("Sales", dimensions, cells);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(TM1Error);
      const err = caught as TM1Error;
      expect(err.code).toBe("TM1_ERROR");
      expect(err.message).toMatch(/partially applied/);
      expect(err.message).toMatch(/9 written/);
      expect(err.message).toMatch(/1 failed/);
      expect(err.message).toMatch(/2 not attempted/);

      const details = JSON.parse(err.details ?? "{}");
      expect(details.written).toBe(9);
      expect(details.notAttempted).toBe(2);
      expect(details.failed).toEqual([
        { elements: ["BAD", "M"], error: "consolidated cell" },
      ]);

      // Batch 2 cells (E10 / E11) were never sent to ExecuteMDX.
      const mdxBodies = fetchSpy.mock.calls
        .filter(([u]) => String(u).includes("/ExecuteMDX"))
        .map(([, o]) => (o as { body?: string }).body ?? "");
      expect(mdxBodies.some((b) => b.includes("[E10]"))).toBe(false);
      expect(mdxBodies.some((b) => b.includes("[E11]"))).toBe(false);
    });
  });

  // ── writeCells() coordinate MDX (D1 escaping / D2 alt-hierarchy) ────────────

  describe("writeCells() coordinate MDX", () => {
    // Accept every write cell; capture the ExecuteMDX slice bodies.
    function routeOk(): void {
      fetchSpy.mockImplementation((url: unknown) => {
        if (String(url).includes("/ExecuteMDX")) {
          return Promise.resolve(mockResponse({ ID: "cs" }));
        }
        return Promise.resolve(mockResponse({}));
      });
    }

    function firstMdx(): string {
      const call = fetchSpy.mock.calls.find(([u]) => String(u).includes("/ExecuteMDX"));
      return JSON.parse((call![1] as { body: string }).body).MDX as string;
    }

    it("D1: doubles `]` in write-coordinate identifiers", async () => {
      routeOk();
      await client.cells.writeCells("Sales", ["Time", "Region"], [
        { elements: ["Q4]Adj", "EU"], value: 5 },
      ]);
      const mdx = firstMdx();
      expect(mdx).toContain("[Time].[Time].[Q4]]Adj]");
      expect(mdx).not.toContain("[Time].[Time].[Q4]Adj]");
    });

    it("D2: honors an explicit alternate hierarchy in a pre-qualified ref", async () => {
      routeOk();
      await client.cells.writeCells("Sales", ["Time", "Region"], [
        { elements: ["[Time].[FiscalCal].[Q4]", "EU"], value: 5 },
      ]);
      const mdx = firstMdx();
      // Alt hierarchy preserved on COLUMNS — NOT rewritten to the default [Time].[Time].[…].
      expect(mdx).toContain("{[Time].[FiscalCal].[Q4]}");
      expect(mdx).not.toContain("[Time].[Time].[Time]");
      // Bare element still defaults hierarchy to the dimension name.
      expect(mdx).toContain("[Region].[Region].[EU]");
    });

    it("defaults hierarchy to the dimension name for bare elements (unchanged behavior)", async () => {
      routeOk();
      await client.cells.writeCells("Sales", ["Time", "Region"], [
        { elements: ["Jan", "EU"], value: 5 },
      ]);
      const mdx = firstMdx();
      expect(mdx).toContain("{[Time].[Time].[Jan]}");
      expect(mdx).toContain("([Region].[Region].[EU])");
    });
  });

  // ── getView() ──────────────────────────────────────────────────────────────

  describe("getView()", () => {
    it("should return ViewResult with cubeName, viewName, cells and axes", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ID: "cellset-200",
          Cells: [
            { Value: 500, FormattedValue: "500.00" },
            { Value: 600, FormattedValue: "600.00" },
          ],
          Axes: [
            {
              Tuples: [
                { Members: [{ Name: "Q1", Hierarchy: { Name: "Time" } }] },
                { Members: [{ Name: "Q2", Hierarchy: { Name: "Time" } }] },
              ],
            },
          ],
        }),
      );

      const result = await client.views.getView("SalesCube", "DefaultView");

      expect(result.cubeName).toBe("SalesCube");
      expect(result.viewName).toBe("DefaultView");
      expect(result.cells).toEqual([
        { value: 500, formattedValue: "500.00" },
        { value: 600, formattedValue: "600.00" },
      ]);
      expect(result.axes).toHaveLength(1);
      expect(result.axes[0].tuples).toHaveLength(2);
    });

    it("should call the correct view execute endpoint", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ID: "cellset-201", Cells: [], Axes: [] }),
      );

      await client.views.getView("MyCube", "MyView");

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("Cubes('MyCube')");
      expect(url).toContain("Views('MyView')");
      expect(url).toContain("tm1.Execute");
      expect(opts.method).toBe("POST");
    });

    it("should encode special characters in cube and view names", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ID: "cellset-202", Cells: [], Axes: [] }),
      );

      await client.views.getView("My Cube", "My View");

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("Cubes('My%20Cube')");
      expect(url).toContain("Views('My%20View')");
    });

    it("should handle empty view result", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ID: "cellset-203", Cells: [], Axes: [] }),
      );

      const result = await client.views.getView("EmptyCube", "EmptyView");

      expect(result.cells).toEqual([]);
      expect(result.axes).toEqual([]);
      expect(result.cubeName).toBe("EmptyCube");
      expect(result.viewName).toBe("EmptyView");
    });
  });

  // ── clearCube() ────────────────────────────────────────────────────────────

  describe("clearCube()", () => {
    function newClient(version: string): TM1Client {
      // Service version-gating branches on the NUMERIC config.version (source of
      // truth); tm1Version is display-only. Derive the numeric from the string.
      const numericVersion: 11 | 12 = version.startsWith("11") ? 11 : 12;
      const cfg = { ...makeConfig(), version: numericVersion, tm1Version: version } as TM1Config;
      const sm = new SessionManager(cfg, mockLogger);
      vi.spyOn(sm, "ensureSession").mockResolvedValue("s");
      vi.spyOn(sm, "authenticate").mockResolvedValue("s");
      return new TM1Client(cfg, sm, mockLogger);
    }

    function mock204(): Response {
      return {
        ok: true,
        status: 204,
        statusText: "No Content",
        headers: new Headers(),
        text: vi.fn().mockResolvedValue(""),
        json: vi.fn().mockRejectedValue(new Error("No content")),
      } as unknown as Response;
    }

    it("12.x: POSTs tm1.Clear with Members@odata.bind tuples", async () => {
      const c = newClient("12.0");
      fetchSpy.mockResolvedValueOnce(mock204());

      await c.cubes.clear("Sales", ["Time", "Region"], [["Jan"], []]);

      const [url, opts] = fetchSpy.mock.calls[0];
      // Reroot-tolerant: a v12 client rewrites the `/api/v1` prefix to the
      // database-rooted path, so assert on the cube+action segment only.
      expect(url).toContain("Cubes('Sales')/tm1.Clear");
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body.Tuples).toHaveLength(2);
      expect(body.Tuples[0]["Members@odata.bind"]).toEqual([
        "Dimensions('Time')/Hierarchies('Time')/Members('Jan')",
      ]);
      expect(body.Tuples[1]["Members@odata.bind"]).toEqual([]);
    });

    it("11.x full clear: deploys ephemeral TI, executes, deletes", async () => {
      const c = newClient("11.8");
      fetchSpy
        .mockResolvedValueOnce(mock204())   // create process
        .mockResolvedValueOnce(mock204())   // execute
        .mockResolvedValueOnce(mock204());  // delete

      await c.cubes.clear("Sales", ["Time", "Region"], [[], []]);

      const [createUrl, createOpts] = fetchSpy.mock.calls[0];
      expect(createUrl).toContain("/api/v1/Processes");
      expect(createOpts.method).toBe("POST");
      const createBody = JSON.parse(createOpts.body);
      expect(createBody.Name).toMatch(/^}TempClear_Sales_\d+$/);
      expect(createBody.PrologProcedure).toBe("CubeClearData('Sales');");

      const [execUrl] = fetchSpy.mock.calls[1];
      expect(execUrl).toMatch(/Processes\('.*'\)\/tm1\.ExecuteWithReturn$/);

      const [delUrl, delOpts] = fetchSpy.mock.calls[2];
      expect(delOpts.method).toBe("DELETE");
      expect(delUrl).toContain("/api/v1/Processes('");
    });

    it("11.x partial clear: throws UNSUPPORTED_OPERATION", async () => {
      const c = newClient("11.8");

      await expect(
        c.cubes.clear("Sales", ["Time", "Region"], [["Jan"], []]),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_OPERATION",
        message: expect.stringContaining("Partial clearCube"),
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ── unloadCube() ───────────────────────────────────────────────────────────

  describe("unloadCube()", () => {
    function mock204(): Response {
      return {
        ok: true,
        status: 204,
        statusText: "No Content",
        headers: new Headers(),
        text: vi.fn().mockResolvedValue(""),
        json: vi.fn().mockRejectedValue(new Error("No content")),
      } as unknown as Response;
    }

    it("POSTs to /api/v1/Cubes('X')/tm1.Unload", async () => {
      fetchSpy.mockResolvedValueOnce(mock204());

      await client.cubes.unload("Sales");

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Cubes('Sales')/tm1.Unload");
      expect(opts.method).toBe("POST");
    });

    it("URL-encodes special characters in cube name", async () => {
      fetchSpy.mockResolvedValueOnce(mock204());

      await client.cubes.unload("Sales Data");

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Cubes('Sales%20Data')/tm1.Unload");
    });
  });

  // ── feeder / calculation tracing ───────────────────────────────────────────

  describe("cell tracing", () => {
    const cubeMeta = {
      Name: "SalesCube",
      Dimensions: [{ Name: "Time" }, { Name: "Region" }],
    };

    describe("checkFeeders()", () => {
      it("binds the tuple and maps fed-cell descriptors", async () => {
        fetchSpy
          .mockResolvedValueOnce(mockResponse(cubeMeta))
          .mockResolvedValueOnce(
            mockResponse({
              value: [
                { Cube: { Name: "TargetCube" }, Tuple: [{ Name: "2024" }, { Name: "EU" }], Fed: true },
                { Cube: { Name: "TargetCube" }, Tuple: [{ Name: "2024" }, { Name: "US" }], Fed: false },
              ],
            }),
          );

        const result = await client.cells.checkFeeders("SalesCube", ["2024", "Total"]);

        expect(result).toEqual([
          { cube: "TargetCube", tuple: ["2024", "EU"], fed: true },
          { cube: "TargetCube", tuple: ["2024", "US"], fed: false },
        ]);

        const [url, opts] = fetchSpy.mock.calls[1];
        expect(url).toContain("/api/v1/Cubes('SalesCube')/tm1.CheckFeeders");
        const body = JSON.parse(opts.body);
        expect(body["Tuple@odata.bind"]).toEqual([
          "Dimensions('Time')/Hierarchies('Time')/Elements('2024')",
          "Dimensions('Region')/Hierarchies('Region')/Elements('Total')",
        ]);
      });

      it("rejects tuple length mismatch without calling the action", async () => {
        fetchSpy.mockResolvedValueOnce(mockResponse(cubeMeta));

        await expect(client.cells.checkFeeders("SalesCube", ["2024"])).rejects.toThrow(
          /2 dimension\(s\)/,
        );
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      });
    });

    describe("traceFeeders()", () => {
      it("maps fed cells and statements", async () => {
        fetchSpy
          .mockResolvedValueOnce(mockResponse(cubeMeta))
          .mockResolvedValueOnce(
            mockResponse({
              FedCells: [{ Cube: { Name: "SalesCube" }, Tuple: [{ Name: "2024" }, { Name: "EU" }], Fed: true }],
              Statements: ["['Units'] => ['Revenue'];"],
            }),
          );

        const result = await client.cells.traceFeeders("SalesCube", ["2024", "EU"]);

        expect(result.fedCells).toHaveLength(1);
        expect(result.statements).toEqual(["['Units'] => ['Revenue'];"]);
        const [url] = fetchSpy.mock.calls[1];
        expect(url).toContain("/tm1.TraceFeeders");
      });
    });

    describe("traceCellCalculation()", () => {
      it("maps the component tree and truncates by depth and width", async () => {
        const leaf = (n: string, v: number) => ({
          Type: "Simple",
          Status: "Data",
          Value: v,
          Tuple: [{ Name: n }, { Name: "EU" }],
          Components: [],
        });
        fetchSpy
          .mockResolvedValueOnce(mockResponse(cubeMeta))
          .mockResolvedValueOnce(
            mockResponse({
              Type: "Consolidation",
              Status: "Data",
              Value: 6,
              Tuple: [{ Name: "Total" }, { Name: "EU" }],
              Statements: [],
              Components: [
                {
                  Type: "Consolidation",
                  Status: "Data",
                  Value: 5,
                  Tuple: [{ Name: "H1" }, { Name: "EU" }],
                  Components: [leaf("Jan", 2), leaf("Feb", 3)],
                },
                leaf("Adj", 1),
                leaf("Extra", 0),
              ],
            }),
          );

        const tree = await client.cells.traceCellCalculation("SalesCube", ["Total", "EU"], 1, 2);

        expect(tree.type).toBe("Consolidation");
        expect(tree.value).toBe(6);
        expect(tree.tuple).toEqual(["Total", "EU"]);
        // width: 3 children, maxComponents=2 → 2 kept + truncated flag
        expect(tree.components).toHaveLength(2);
        expect(tree.truncated).toBe(true);
        // depth: maxDepth=1 → grandchildren cut, child marked truncated
        expect(tree.components![0]!.truncated).toBe(true);
        expect(tree.components![0]!.components).toBeUndefined();
        const [url] = fetchSpy.mock.calls[1];
        expect(url).toContain("/tm1.TraceCellCalculation");
        expect(url).toContain("Components/Tuple($select=Name)");
      });
    });
  });
});
