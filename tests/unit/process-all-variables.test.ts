// `getAllVariables` replaces a per-process fan-out with one request.
//
// tm1_audit_complexity used to list every process, then ask each one for its
// Variables — 221 extra round trips on a real model, measured. `Variables` is
// a complex-typed property, not a navigation, so the process list can carry it
// directly: one request, no fan-out, and nothing partial to reconcile.
import { describe, it, expect, vi } from "vitest";
import { contractCheckedHttp } from "../helpers/contract-http.js";
import { ProcessService } from "../../src/tm1-client/services/process-service.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";

function makeService(rows: Array<Record<string, unknown>>): {
  svc: ProcessService;
  paths: string[];
} {
  const paths: string[] = [];
  const http = contractCheckedHttp({
    request: vi.fn(async (_method: string, path: string) => {
      paths.push(path);
      return { value: rows };
    }),
  } as unknown as TM1HttpClient);
  return { svc: new ProcessService(http), paths };
}

describe("ProcessService.getAllVariables", () => {
  it("asks once, selecting Variables alongside the name", async () => {
    const { svc, paths } = makeService([]);
    await svc.getAllVariables();

    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("$select=Name,Variables");
    // Control objects stay out unless asked for, same as getAllCode.
    expect(paths[0]).toContain("not startswith(Name,'}')");
  });

  it("includes control processes on request", async () => {
    const { svc, paths } = makeService([]);
    await svc.getAllVariables(true);
    expect(paths[0]).not.toContain("startswith");
  });

  it("maps each process to its variables", async () => {
    const { svc } = makeService([
      {
        Name: "Load.Sales",
        Variables: [
          { Name: "vCustomer", Type: "String", Position: 1 },
          { Name: "vAmount", Type: "Numeric", Position: 2 },
        ],
      },
      { Name: "Util.NoVars", Variables: [] },
    ]);

    const byProcess = await svc.getAllVariables();

    expect(byProcess.get("Load.Sales")).toEqual([
      { name: "vCustomer", type: "String", position: 1 },
      { name: "vAmount", type: "Numeric", position: 2 },
    ]);
    expect(byProcess.get("Util.NoVars")).toEqual([]);
  });

  it("carries the byte offsets of a fixed-width source when present", async () => {
    const { svc } = makeService([
      {
        Name: "Load.Fixed",
        Variables: [
          {
            Name: "vId",
            Type: "String",
            Position: 1,
            StartByte: 0,
            EndByte: 7,
          },
        ],
      },
    ]);
    expect((await svc.getAllVariables()).get("Load.Fixed")).toEqual([
      { name: "vId", type: "String", position: 1, startByte: 0, endByte: 7 },
    ]);
  });

  it("treats an absent Variables array as no variables", async () => {
    // $select on a complex property omits it entirely when the process has
    // none, rather than sending an empty array.
    const { svc } = makeService([{ Name: "Util.Bare" }]);
    expect((await svc.getAllVariables()).get("Util.Bare")).toEqual([]);
  });

  it("classifies any non-Numeric type as String, as getVariables does", async () => {
    const { svc } = makeService([
      { Name: "P", Variables: [{ Name: "v", Type: "Unknown", Position: 1 }] },
    ]);
    expect((await svc.getAllVariables()).get("P")?.[0]?.type).toBe("String");
  });
});
