import { describe, it, expect, vi } from "vitest";
import { ServerService } from "../../src/tm1-client/services/server-service.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

// D3: get_message_log must push its text/level/time filters to the server via
// $filter, so a matching entry OLDER than the newest `top` rows is still found
// (client-side filtering over only the newest window produced false negatives).
function makeHttp(impl: (method: string, path: string) => Promise<unknown>): {
  http: TM1HttpClient;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(impl);
  return { http: { request } as unknown as TM1HttpClient, request };
}

const OLD_MATCH = {
  TimeStamp: "2020-01-01T00:00:00Z",
  Level: "error",
  Message: 'Process "Load" aborted, see TM1ProcessError_20200101000000_1_Load.log',
};

describe("ServerService.getMessageLog — server-side $filter (D3)", () => {
  it("builds a case-insensitive contains() $filter and returns a match beyond the top window", async () => {
    // The server, applying $filter across the WHOLE log, returns the old match
    // even though it is far older than the newest `top=100` rows. The service
    // no longer post-filters, so it surfaces the server's authoritative result.
    const { http, request } = makeHttp(async (_m, path) => {
      expect(path).toContain("$filter=");
      expect(path).toContain("contains(tolower(Message)");
      expect(path).toContain("tm1processerror"); // lowercased needle
      return { value: [OLD_MATCH] };
    });
    const svc = new ServerService(http);

    const entries = await svc.getMessageLog({ filter: "TM1ProcessError", top: 100 });

    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toContain("TM1ProcessError_20200101000000_1_Load.log");
    expect(entries[0]!.errorFile).toBe("TM1ProcessError_20200101000000_1_Load.log");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("combines level and since into the $filter clause", async () => {
    const { http } = makeHttp(async (_m, path) => {
      // decode to compare the OData clause independent of percent-encoding
      const decoded = decodeURIComponent(path);
      expect(decoded).toContain("toupper(Level) eq 'ERROR'");
      expect(decoded).toContain("TimeStamp ge 2026-06-01T00:00:00Z");
      expect(decoded).toContain(" and ");
      return { value: [] };
    });
    const svc = new ServerService(http);
    await svc.getMessageLog({ level: "error", since: "2026-06-01" });
  });

  it("omits $filter entirely when no filter is given (plain newest-N fetch)", async () => {
    const { http } = makeHttp(async (_m, path) => {
      expect(path).not.toContain("$filter");
      expect(path).toContain("$top=100");
      return { value: [] };
    });
    const svc = new ServerService(http);
    await svc.getMessageLog({});
  });

  it("falls back to client-side filtering when the server rejects the filter expression", async () => {
    let call = 0;
    const { http, request } = makeHttp(async (_m, path) => {
      call += 1;
      if (call === 1) {
        expect(path).toContain("$filter="); // filtered attempt
        throw new TM1Error({ code: TM1ErrorCode.TM1_ERROR, message: "bad filter" });
      }
      expect(path).not.toContain("$filter"); // degraded newest-N fetch
      return {
        value: [
          OLD_MATCH,
          { TimeStamp: "2020-01-02T00:00:00Z", Level: "info", Message: "unrelated line" },
        ],
      };
    });
    const svc = new ServerService(http);

    const entries = await svc.getMessageLog({ filter: "TM1ProcessError" });

    expect(request).toHaveBeenCalledTimes(2);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toContain("TM1ProcessError");
  });

  it("fallback re-applies since/until/logger client-side (no out-of-range matches)", async () => {
    let call = 0;
    const { http } = makeHttp(async (_m, path) => {
      call += 1;
      if (call === 1) throw new TM1Error({ code: TM1ErrorCode.TM1_ERROR, message: "bad filter" });
      expect(path).not.toContain("$filter");
      return {
        value: [
          { TimeStamp: "2026-06-15T00:00:00Z", Level: "error", Message: "recent boom", Logger: "TM1.Process" },
          { ...OLD_MATCH, Message: "old boom", Logger: "TM1.Process" }, // 2020 — before `since`
        ],
      };
    });
    const svc = new ServerService(http);

    const entries = await svc.getMessageLog({ filter: "boom", since: "2026-01-01", logger: "TM1.Process" });

    expect(call).toBe(2);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toBe("recent boom"); // 2020 row dropped by since
  });

  it("does NOT fall back on a systemic transport error — it surfaces", async () => {
    const { http } = makeHttp(async () => {
      throw new TM1Error({ code: TM1ErrorCode.CONNECTION_FAILED, message: "down" });
    });
    const svc = new ServerService(http);

    await expect(svc.getMessageLog({ filter: "x" })).rejects.toMatchObject({
      code: TM1ErrorCode.CONNECTION_FAILED,
    });
  });
});
