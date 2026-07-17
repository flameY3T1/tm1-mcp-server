import { describe, it, expect, vi } from "vitest";
import { MonitoringService } from "../../src/tm1-client/services/monitoring-service.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";

function svcWith(responseData: any) {
  const request = vi.fn().mockResolvedValue(responseData);
  const http = { request } as any as TM1HttpClient;
  const svc = new MonitoringService(http);
  return { svc, request };
}

describe("MonitoringService.getJobs", () => {
  it("fetches and transforms jobs with all fields", async () => {
    const { svc, request } = svcWith({
      value: [
        {
          ID: "job-1",
          Description: "Executing process X",
          State: "Running",
          ElapsedTime: "PT5S",
          WaitTime: "PT1S",
          Session: { ID: 42, Context: "client/1.0", User: { Name: "Admin" } },
          WaitingOn: [{ ID: "job-2", Description: "blocker", State: "Waiting" }],
        },
      ],
    });
    const jobs = await svc.getJobs();
    expect(jobs).toEqual([
      {
        id: "job-1",
        description: "Executing process X",
        state: "Running",
        elapsedTime: "PT5S",
        waitTime: "PT1S",
        session: { id: "42", context: "client/1.0", user: "Admin" },
        waitingOn: [{ id: "job-2", description: "blocker", state: "Waiting" }],
      },
    ]);
    expect(request).toHaveBeenCalledWith("GET", expect.stringContaining("/api/v1/Jobs"));
  });

  it("omits optional fields when session/waitingOn/times are absent", async () => {
    const { svc } = svcWith({ value: [{ ID: "j", Description: "d", State: "Running" }] });
    const jobs = await svc.getJobs();
    expect(jobs[0]).toEqual({ id: "j", description: "d", state: "Running" });
  });

  it("is null-safe: null/missing required and optional fields do not throw and map to safe defaults", async () => {
    const { svc } = svcWith({
      value: [
        {
          ID: 7,
          Description: null,
          State: null,
          WaitTime: null,
          ElapsedTime: null,
          Session: { ID: 5, Context: null, User: { Name: null } },
          WaitingOn: [{ ID: "j2", Description: null, State: null }],
        },
      ],
    });
    const jobs = await svc.getJobs();
    expect(jobs).toEqual([
      {
        id: "7",
        description: "",
        state: "",
        session: { id: "5" },
        waitingOn: [{ id: "j2", description: "", state: "" }],
      },
    ]);
  });
});

describe("MonitoringService.cancelJob", () => {
  it("POSTs bound Cancel action with simple id", async () => {
    const { svc, request } = svcWith(undefined);
    await svc.cancelJob("job-1");
    expect(request).toHaveBeenCalledWith("POST", "/api/v1/Jobs('job-1')/tm1.Cancel", {});
  });

  it("doubles single-quotes and url-encodes id", async () => {
    const { svc, request } = svcWith(undefined);
    await svc.cancelJob("j'1");
    expect(request).toHaveBeenCalledWith("POST", "/api/v1/Jobs('j%27%271')/tm1.Cancel", {});
  });

  it("url-encodes non-quote special characters in the id", async () => {
    const { svc, request } = svcWith(undefined);
    await svc.cancelJob("a b/c");
    expect(request).toHaveBeenCalledWith("POST", "/api/v1/Jobs('a%20b%2Fc')/tm1.Cancel", {});
  });
});
