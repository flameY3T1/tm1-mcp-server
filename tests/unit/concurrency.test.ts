import { describe, it, expect } from "vitest";
import { mapSettledWithConcurrency } from "../../src/lib/concurrency.js";

describe("mapSettledWithConcurrency", () => {
  it("returns index-aligned fulfilled results", async () => {
    const out = await mapSettledWithConcurrency([1, 2, 3, 4], 2, (n) =>
      Promise.resolve(n * 10),
    );
    expect(out.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual([
      10, 20, 30, 40,
    ]);
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    await mapSettledWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("captures rejections without rejecting the whole call", async () => {
    const out = await mapSettledWithConcurrency([1, 2, 3], 2, (n) =>
      n === 2 ? Promise.reject(new Error("boom")) : Promise.resolve(n),
    );
    expect(out[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(out[1]?.status).toBe("rejected");
    expect(out[2]).toEqual({ status: "fulfilled", value: 3 });
  });
});
