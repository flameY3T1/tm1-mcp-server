import { describe, it, expect } from "vitest";
import {
  mapSettledWithConcurrency,
  mapWithConcurrency,
} from "../../src/lib/concurrency.js";

describe("mapSettledWithConcurrency", () => {
  it("returns index-aligned fulfilled results", async () => {
    const out = await mapSettledWithConcurrency([1, 2, 3, 4], 2, (n) =>
      Promise.resolve(n * 10),
    );
    expect(out.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual(
      [10, 20, 30, 40],
    );
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    await mapSettledWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      },
    );
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

describe("mapWithConcurrency", () => {
  it("resolves to the values in item order", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, (n) => Promise.resolve(n * 10)),
    ).resolves.toEqual([10, 20, 30]);
  });

  it("rejects with the first failure in item order after all settle", async () => {
    const done: number[] = [];
    await expect(
      mapWithConcurrency([0, 1, 2, 3], 4, async (n) => {
        // Item 3 fails first in time; item 1 is first in item order.
        await new Promise((r) => setTimeout(r, n === 3 ? 0 : 5));
        done.push(n);
        if (n === 1 || n === 3) throw new Error(`item ${n}`);
        return n;
      }),
    ).rejects.toThrow("item 1");
    expect(done.sort()).toEqual([0, 1, 2, 3]);
  });
});
