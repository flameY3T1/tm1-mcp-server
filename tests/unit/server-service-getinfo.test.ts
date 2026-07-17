import { describe, it, expect, vi } from "vitest";
import { ServerService } from "../../src/tm1-client/services/server-service.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";

// getInfo() only ever calls http.request(...) — a minimal fake covering that
// one method is enough to drive ServerService without pulling in the full
// TM1Client/SessionManager/fetch stack (see tm1-client-transaction-log.test.ts
// for that heavier pattern, used where session/keepalive plumbing matters).
function makeHttp(requestImpl: (method: string, path: string) => Promise<unknown>): TM1HttpClient {
  return { request: vi.fn(requestImpl) } as unknown as TM1HttpClient;
}

describe("ServerService.getInfo() — v12 ProductVersion fallback", () => {
  it("v11: uses the inline Configuration.ProductVersion and never requests the scalar sub-resource", async () => {
    const request = vi.fn(async (_method: string, path: string) => {
      if (path === "/api/v1/Configuration") {
        return { ServerName: "s", ProductVersion: "11.8.0" };
      }
      if (path === "/api/v1/ActiveConfiguration") {
        return {};
      }
      throw new Error(`unexpected path: ${path}`);
    });
    const server = new ServerService(makeHttp(request));

    const info = await server.getInfo();

    expect(info.productVersion).toBe("11.8.0");
    expect(request).not.toHaveBeenCalledWith("GET", "/api/v1/Configuration/ProductVersion");
  });

  it("v12: falls back to the ProductVersion scalar sub-resource when the inline field is absent", async () => {
    const request = vi.fn(async (_method: string, path: string) => {
      if (path === "/api/v1/Configuration") {
        return { ServerName: "s" }; // no ProductVersion — v12/PAE behavior
      }
      if (path === "/api/v1/ActiveConfiguration") {
        return {};
      }
      if (path === "/api/v1/Configuration/ProductVersion") {
        return { value: "12.5.9" };
      }
      throw new Error(`unexpected path: ${path}`);
    });
    const server = new ServerService(makeHttp(request));

    const info = await server.getInfo();

    expect(info.productVersion).toBe("12.5.9");
    expect(request).toHaveBeenCalledWith("GET", "/api/v1/Configuration/ProductVersion");
  });

  it("falls back to an empty string (no throw) when the scalar sub-resource is also unavailable", async () => {
    const request = vi.fn(async (_method: string, path: string) => {
      if (path === "/api/v1/Configuration") {
        return { ServerName: "s" };
      }
      if (path === "/api/v1/ActiveConfiguration") {
        return {};
      }
      if (path === "/api/v1/Configuration/ProductVersion") {
        throw new Error("404 not found");
      }
      throw new Error(`unexpected path: ${path}`);
    });
    const server = new ServerService(makeHttp(request));

    const info = await server.getInfo();

    expect(info.productVersion).toBe("");
  });
});
