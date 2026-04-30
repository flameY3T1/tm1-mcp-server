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

function mockResponse(status: number, body?: unknown): Response {
  const bodyText = body !== undefined ? JSON.stringify(body) : "";
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 204 ? "No Content" : "OK",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(bodyText),
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TM1Client – Dimension Management Methods", () => {
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

  // ── createElement() ──────────────────────────────────────────────────────

  describe("createElement()", () => {
    it("should create a Numeric element", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(204));

      await client.createElement("Region", "Region", {
        name: "Germany",
        type: "Numeric",
      });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Dimensions('Region')/Hierarchies('Region')/Elements");
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body).toEqual({ Name: "Germany", Type: "Numeric" });
    });

    it("should create a String element", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(204));

      await client.createElement("Region", "Region", {
        name: "Description",
        type: "String",
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body).toEqual({ Name: "Description", Type: "String" });
    });

    it("should create a Consolidated element with components", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(204));

      await client.createElement("Region", "Region", {
        name: "Europe",
        type: "Consolidated",
        components: [
          { name: "Germany", weight: 1 },
          { name: "France", weight: 1 },
        ],
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.Name).toBe("Europe");
      expect(body.Type).toBe("Consolidated");
      expect(body.Components).toHaveLength(2);
      expect(body.Components[0]["@odata.id"]).toContain("Elements('Germany')");
      expect(body.Components[0].Weight).toBe(1);
      expect(body.Components[1]["@odata.id"]).toContain("Elements('France')");
    });

    it("should not include Components for Consolidated with empty components array", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(204));

      await client.createElement("Region", "Region", {
        name: "EmptyTotal",
        type: "Consolidated",
        components: [],
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.Components).toBeUndefined();
    });

    it("should encode special characters in dimension and hierarchy names", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(204));

      await client.createElement("My Dim", "My Hier", {
        name: "Test",
        type: "Numeric",
      });

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("Dimensions('My%20Dim')");
      expect(url).toContain("Hierarchies('My%20Hier')");
    });
  });

  // ── updateElement() ──────────────────────────────────────────────────────

  describe("updateElement()", () => {
    it("should update element name", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(204));

      await client.updateElement("Region", "Region", "Germany", {
        newName: "Deutschland",
      });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("Elements('Germany')");
      expect(opts.method).toBe("PATCH");
      const body = JSON.parse(opts.body);
      expect(body).toEqual({ Name: "Deutschland" });
    });

    it("should update element type", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(204));

      await client.updateElement("Region", "Region", "Germany", {
        type: "Consolidated",
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body).toEqual({ Type: "Consolidated" });
    });

    it("should update element components", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(204));

      await client.updateElement("Region", "Region", "Europe", {
        components: [
          { name: "Germany", weight: 1 },
          { name: "France", weight: 2 },
        ],
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.Components).toHaveLength(2);
      expect(body.Components[0]["@odata.id"]).toContain("Elements('Germany')");
      expect(body.Components[0].Weight).toBe(1);
      expect(body.Components[1].Weight).toBe(2);
    });

    it("should update multiple fields at once", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(204));

      await client.updateElement("Region", "Region", "Germany", {
        newName: "Deutschland",
        type: "String",
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body).toEqual({ Name: "Deutschland", Type: "String" });
    });

    it("should encode special characters in element name", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(204));

      await client.updateElement("Region", "Region", "My Element", {
        newName: "New Name",
      });

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("Elements('My%20Element')");
    });
  });

  // ── deleteElement() ──────────────────────────────────────────────────────

  describe("deleteElement()", () => {
    it("should delete an element (204 No Content)", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(204));

      await client.deleteElement("Region", "Region", "Germany");

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("Dimensions('Region')/Hierarchies('Region')/Elements('Germany')");
      expect(opts.method).toBe("DELETE");
    });

    it("should throw TM1Error when element is referenced and cannot be deleted", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        headers: new Headers(),
        text: vi.fn().mockResolvedValue(
          JSON.stringify({
            error: {
              message: {
                value: "Element 'Germany' is referenced in rules and cannot be deleted",
              },
            },
          }),
        ),
      } as unknown as Response);

      await expect(
        client.deleteElement("Region", "Region", "Germany"),
      ).rejects.toThrow(TM1Error);

      try {
        fetchSpy.mockResolvedValueOnce({
          ok: false,
          status: 400,
          statusText: "Bad Request",
          headers: new Headers(),
          text: vi.fn().mockResolvedValue(
            JSON.stringify({
              error: {
                message: {
                  value: "Element 'Germany' is referenced in rules and cannot be deleted",
                },
              },
            }),
          ),
        } as unknown as Response);
        await client.deleteElement("Region", "Region", "Germany");
      } catch (err) {
        expect(err).toBeInstanceOf(TM1Error);
        const tm1Err = err as TM1Error;
        expect(tm1Err.httpStatus).toBe(400);
        expect(tm1Err.message).toContain("referenced in rules");
      }
    });

    it("should encode special characters in element name", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(204));

      await client.deleteElement("Region", "Region", "My Element");

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("Elements('My%20Element')");
    });
  });

  // ── moveElement() ────────────────────────────────────────────────────────

  describe("moveElement()", () => {
    it("should move an element to a new parent with default weight", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(204));

      await client.moveElement("Region", "Region", "Germany", "Europe");

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("Elements('Europe')/Components");
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body["@odata.id"]).toContain("Elements('Germany')");
      expect(body.Weight).toBe(1);
    });

    it("should move an element with a custom weight", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(204));

      await client.moveElement("Region", "Region", "Germany", "Europe", 2.5);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.Weight).toBe(2.5);
    });

    it("should encode special characters in element and parent names", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(204));

      await client.moveElement("My Dim", "My Hier", "Child Elem", "Parent Elem");

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("Dimensions('My%20Dim')");
      expect(url).toContain("Hierarchies('My%20Hier')");
      expect(url).toContain("Elements('Parent%20Elem')");
      const body = JSON.parse(opts.body);
      expect(body["@odata.id"]).toContain("Elements('Child%20Elem')");
    });

    it("should use weight 0 when explicitly passed", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(204));

      await client.moveElement("Region", "Region", "Germany", "Europe", 0);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.Weight).toBe(0);
    });
  });
});
