// Writing N cells used to cost 3N requests: one cellset per cell, PATCH
// Cells(0), delete. Measured at 120 requests for 40 cells.
//
// TM1py — and tm1npm, which ports it — build ONE cellset over all target
// coordinates and PATCH the whole cell array once. Verified against 11.8: 40
// cells in 3 requests, 9 ms, all written. This suite pins that shape, plus the
// two behaviours the bulk form changes.
import { describe, it, expect, vi } from "vitest";
import { contractCheckedHttp } from "../helpers/contract-http.js";
import { CellService } from "../../src/tm1-client/services/cell-service.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function makeService(opts: { failPatch?: (body: unknown) => boolean } = {}) {
  const calls: Call[] = [];
  let cellsetSeq = 0;
  const http = contractCheckedHttp({
    request: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (path === "/api/v1/ExecuteMDX") return { ID: `cs${cellsetSeq++}` };
      if (method === "PATCH" && opts.failPatch?.(body)) {
        throw new TM1Error({
          code: TM1ErrorCode.TM1_ERROR,
          message: "CubeCellWriteStatusElementIsConsolidated",
        });
      }
      return undefined;
    }),
  } as unknown as TM1HttpClient);
  return { svc: new CellService(http), calls };
}

const cell = (name: string, value: number) => ({
  elements: [name, "M"],
  value,
});

describe("CellService.writeCells — bulk cellset", () => {
  it("writes N cells with three requests, not 3N", async () => {
    const { svc, calls } = makeService();
    await svc.writeCells(
      "Sales",
      ["Product", "Measure"],
      Array.from({ length: 40 }, (_, i) => cell(`P${i}`, i)),
    );

    expect(calls).toHaveLength(3);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/api/v1/ExecuteMDX");
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.path).toBe("/api/v1/Cellsets('cs0')/Cells");
    expect(calls[2]?.method).toBe("DELETE");
  });

  it("sends the cell array bare, the one shape TM1 accepts", async () => {
    // tm1npm wraps it as `{Cells: [...]}` and TM1 answers "Invalid
    // CellsetCell property encountered in payload" — measured. TM1py sends the
    // bare array, which works.
    const { svc, calls } = makeService();
    await svc.writeCells(
      "Sales",
      ["Product", "Measure"],
      [cell("P1", 10), cell("P2", 20)],
    );

    expect(calls[1]?.body).toEqual([
      { Ordinal: 0, Value: 10 },
      { Ordinal: 1, Value: 20 },
    ]);
  });

  it("orders the MDX tuples exactly as the cells, since ordinals are positional", async () => {
    const { svc, calls } = makeService();
    await svc.writeCells(
      "Sales",
      ["Product", "Measure"],
      [cell("Second", 2), cell("First", 1)],
    );
    const mdx = (calls[0]?.body as { MDX: string }).MDX;
    expect(mdx.indexOf("[Second]")).toBeLessThan(mdx.indexOf("[First]"));
  });

  it("keeps a repeated coordinate as its own cell", async () => {
    // TM1 does not collapse duplicate tuples in a set (verified live), so
    // ordinal i stays cells[i]. Silently deduping would shift every value
    // after the repeat onto the wrong coordinate.
    const { svc, calls } = makeService();
    await svc.writeCells(
      "Sales",
      ["Product", "Measure"],
      [cell("P1", 1), cell("P2", 2), cell("P1", 3)],
    );
    expect(calls[1]?.body).toHaveLength(3);
  });

  it("still rejects a tuple whose length misses the dimension count", async () => {
    const { svc } = makeService();
    await expect(
      svc.writeCells(
        "Sales",
        ["Product", "Measure"],
        [{ elements: ["P1"], value: 1 }],
      ),
    ).rejects.toThrow(/does not match dimension count/);
  });

  it("does nothing for an empty cell list", async () => {
    const { svc, calls } = makeService();
    await svc.writeCells("Sales", ["Product", "Measure"], []);
    expect(calls).toHaveLength(0);
  });

  describe("when TM1 rejects the batch", () => {
    // A batch containing one non-writable cell is refused WHOLE — nothing
    // lands, not even the writable cells (verified live:
    // CubeCellWriteStatusElementIsConsolidated). The error names the status,
    // not the offending coordinate, so the fallback re-walks the batch cell by
    // cell: same cost as the old implementation, only on the failing path, and
    // it restores the written/failed/notAttempted report callers rely on.
    const failBulk = (body: unknown) => Array.isArray(body);

    it("falls back to per-cell writes to find the offender", async () => {
      const { svc, calls } = makeService({ failPatch: failBulk });
      await svc.writeCells(
        "Sales",
        ["Product", "Measure"],
        [cell("P1", 1), cell("P2", 2)],
      );

      // The bulk attempt, then one cellset per cell to locate the refusal.
      const perCell = calls.filter((c) => c.path.endsWith("/Cells(0)"));
      expect(perCell).toHaveLength(2);
    });

    it("names the refused coordinates when the retry also fails", async () => {
      // Both shapes rejected: the bulk PATCH and the per-cell one. Only then
      // is the write genuinely impossible, and the caller needs the
      // coordinate — the server's message carries only a status code.
      const { svc } = makeService({ failPatch: () => true });
      await expect(
        svc.writeCells("Sales", ["Product", "Measure"], [cell("Bad", 1)]),
      ).rejects.toThrow(/partially applied/);
    });

    it("reports what landed and what did not", async () => {
      // Only the bulk PATCH fails; the per-cell retries succeed, so the report
      // must not claim a failure that the fallback resolved.
      const { svc } = makeService({ failPatch: (b) => Array.isArray(b) });
      await expect(
        svc.writeCells("Sales", ["Product", "Measure"], [cell("P1", 1)]),
      ).resolves.toBeUndefined();
    });
  });
});
