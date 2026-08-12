// TM1 accepts `Weight` inside a Components link payload and ignores it: the
// edge is created with weight 1 whatever you send. Verified live — a
// consolidation created with weight -1 read back as 1, from the Edges
// collection itself, so nothing downstream could have recovered it.
//
// A dropped -1 is not cosmetic. It is the weight that nets costs against
// revenue; silently turning it into +1 inverts the consolidation.
//
// The weight lives on the Edge entity and has to be PATCHed once the link
// exists. These tests pin that the extra call happens exactly when it is
// needed — and not when it is not.
import { describe, it, expect, vi } from "vitest";
import { contractCheckedHttp } from "../helpers/contract-http.js";
import { ElementService } from "../../src/tm1-client/services/element-service.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";
import type { CellService } from "../../src/tm1-client/services/cell-service.js";

function makeService() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const http = contractCheckedHttp({
    request: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return undefined;
    }),
  } as unknown as TM1HttpClient);
  const svc = new ElementService(http, undefined as unknown as CellService);
  return { svc, calls };
}

const edgeCalls = (
  calls: Array<{ method: string; path: string; body?: unknown }>,
) => calls.filter((c) => c.path.includes("/Edges("));

describe("element edge weights", () => {
  it("patches the edge after creating a consolidation with a non-default weight", async () => {
    const { svc, calls } = makeService();
    await svc.create("Dim", "Dim", {
      name: "C1",
      type: "Consolidated",
      components: [{ name: "L1", weight: -1 }],
    });

    expect(calls[0]?.method).toBe("POST");
    const edges = edgeCalls(calls);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.method).toBe("PATCH");
    expect(edges[0]?.path).toContain(
      "Edges(ParentName='C1',ComponentName='L1')",
    );
    expect(edges[0]?.body).toEqual({ Weight: -1 });
  });

  it("does not patch when every weight is the TM1 default", async () => {
    // The link payload already yields weight 1, so a PATCH would be a round
    // trip that changes nothing — and consolidations are usually all-1.
    const { svc, calls } = makeService();
    await svc.create("Dim", "Dim", {
      name: "C1",
      type: "Consolidated",
      components: [{ name: "L1", weight: 1 }, { name: "L2" }],
    });
    expect(edgeCalls(calls)).toHaveLength(0);
  });

  it("patches only the components that deviate", async () => {
    const { svc, calls } = makeService();
    await svc.create("Dim", "Dim", {
      name: "C1",
      type: "Consolidated",
      components: [
        { name: "Keep", weight: 1 },
        { name: "Net", weight: -1 },
        { name: "Half", weight: 0.5 },
      ],
    });
    const edges = edgeCalls(calls);
    expect(edges.map((c) => c.body)).toEqual([{ Weight: -1 }, { Weight: 0.5 }]);
  });

  it("applies to a component replacement too", async () => {
    const { svc, calls } = makeService();
    await svc.update("Dim", "Dim", "C1", {
      components: [{ name: "L1", weight: -1 }],
    });
    expect(calls[0]?.method).toBe("PATCH");
    expect(edgeCalls(calls)[0]?.body).toEqual({ Weight: -1 });
  });

  it("applies when moving an element under a new parent", async () => {
    const { svc, calls } = makeService();
    await svc.move("Dim", "Dim", "L1", "C2", -1);
    expect(calls[0]?.method).toBe("POST");
    expect(edgeCalls(calls)[0]?.path).toContain(
      "Edges(ParentName='C2',ComponentName='L1')",
    );
    expect(edgeCalls(calls)[0]?.body).toEqual({ Weight: -1 });
  });

  it("escapes quotes in the edge key", async () => {
    const { svc, calls } = makeService();
    await svc.create("Dim", "Dim", {
      name: "O'Brien",
      type: "Consolidated",
      components: [{ name: "X'Y", weight: -1 }],
    });
    expect(edgeCalls(calls)[0]?.path).toContain(
      "Edges(ParentName='O''Brien',ComponentName='X''Y')",
    );
  });
});
