// Live validation for the 2026-08-05 audit fixes. The unit suites prove the
// logic in isolation with mocks; these prove the same code paths behave against
// a real TM1 server — the exact gap the review named as its own blind spot
// ("no run had a TM1 server, so every v11/v12 statement is code-derived").
//
// Covers: M12 (truncation sentinel), S10 (timestamp validation), P12 (parallel
// view scopes), P2 (invalidation narrowing), T1 (response wire shape).
// Creates exactly one sandbox process and deletes it again.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getHarness,
  LIVE_ENABLED,
  SANDBOX,
  type LiveHarness,
} from "./harness.js";
import {
  buildIndexFromTM1,
  getCallgraphCacheStats,
  invalidateCallgraphCache,
  registerCallgraphCacheInvalidation,
} from "../../src/lib/callgraph/tm1-adapter.js";

const PROBE_PROC = `${SANDBOX}_P2_PROBE`;

describe.skipIf(!LIVE_ENABLED)("live: audit fixes 2026-08-05", () => {
  let h: LiveHarness;
  beforeAll(async () => {
    h = await getHarness();
  });

  afterAll(async () => {
    await h.call("tm1_delete_process", {
      processName: PROBE_PROC,
      confirm: PROBE_PROC,
    });
  });

  // ---- M12: truncated must be evidence, not inference -------------------
  describe("M12 — sample_cells truncation sentinel", () => {
    it("reports truncated=false when the result is exactly the page size", async () => {
      const cubes = await h.ok("tm1_list_cubes", { limit: 50 });
      const names: string[] = (cubes.json.items ?? []).map(
        (c: { name: string }) => c.name,
      );

      // Find a cube with FEWER populated cells than the probe limit — that is
      // the case the old `cells.length >= maxCells` comparison could not tell
      // apart from "more exist".
      let found: { cube: string; n: number } | undefined;
      for (const cube of names) {
        const r = await h.call("tm1_sample_cells", {
          cubeName: cube,
          maxCells: 20,
        });
        if (r.isError) continue;
        const n: number = r.json?.count ?? 0;
        if (n > 0 && n < 20) {
          found = { cube, n };
          break;
        }
      }
      if (!found) {
        // Nothing on this server fits the shape — say so instead of asserting
        // something vacuous.
        console.warn(
          "M12: no cube with 0 < populated cells < 20; not asserted",
        );
        return;
      }

      // Ask for exactly as many cells as exist: must NOT report truncation.
      const exact = await h.ok("tm1_sample_cells", {
        cubeName: found.cube,
        maxCells: found.n,
      });
      expect(exact.json.count).toBe(found.n);
      expect(exact.json.truncated).toBe(false);

      // Ask for one fewer: genuinely truncated.
      if (found.n > 1) {
        const short = await h.ok("tm1_sample_cells", {
          cubeName: found.cube,
          maxCells: found.n - 1,
        });
        expect(short.json.count).toBe(found.n - 1);
        expect(short.json.truncated).toBe(true);
      }
    });
  });

  // ---- S10: reject bad timestamps before they reach OData ----------------
  describe("S10 — timestamp validation", () => {
    it("rejects a non-ISO timestamp with a named error instead of an OData parse failure", async () => {
      const r = await h.call("tm1_get_message_log", {
        since: "yesterday",
        top: 1,
      });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Not a usable timestamp/);
      expect(r.text).toMatch(/yesterday/);
    });

    it("rejects an ambiguous locale date rather than silently picking a day", async () => {
      const r = await h.call("tm1_get_message_log", {
        since: "08/06/2026",
        top: 1,
      });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Not a usable timestamp/);
    });

    it("still accepts ISO-8601 and reaches the server", async () => {
      const since = new Date(Date.now() - 10 * 60_000).toISOString();
      const r = await h.ok("tm1_get_message_log", { since, top: 5 });
      expect(r.json).toBeTruthy();
    });
  });

  // ---- P12: both view scopes still arrive, now in parallel ---------------
  describe("P12 — parallel public/private view listing", () => {
    it("returns both scopes with public entries first", async () => {
      const cubes = await h.ok("tm1_list_cubes", { limit: 10 });
      const names: string[] = (cubes.json.items ?? []).map(
        (c: { name: string }) => c.name,
      );
      let sawAny = false;
      for (const cube of names) {
        const r = await h.call("tm1_list_views", { cubeName: cube, limit: 50 });
        if (r.isError) continue;
        const items: Array<{ private: boolean }> = r.json.items ?? [];
        if (items.length === 0) continue;
        sawAny = true;
        // Order contract: every public entry precedes every private one.
        const firstPrivate = items.findIndex((v) => v.private);
        if (firstPrivate >= 0) {
          expect(items.slice(firstPrivate).every((v) => v.private)).toBe(true);
        }
        break;
      }
      expect(sawAny).toBe(true);
    });
  });

  // ---- P2: only code-relevant mutations may drop the index ---------------
  describe("P2 — callgraph invalidation is narrowed", () => {
    it("an MDX read does NOT discard the index, a process write does", async () => {
      registerCallgraphCacheInvalidation();
      invalidateCallgraphCache();

      await buildIndexFromTM1(h.client);
      expect(getCallgraphCacheStats()).toHaveLength(1);

      const cubes = await h.ok("tm1_list_cubes", { limit: 1 });
      const cube: string | undefined = cubes.json.items?.[0]?.name;
      expect(cube).toBeTruthy();

      // ExecuteMDX is a POST, so the HTTP layer emits a mutation event for it.
      // Before the fix this alone threw the whole index away. Whether the query
      // itself succeeds is irrelevant — the POST is what used to invalidate.
      await h.call("tm1_execute_mdx", {
        mdx: `SELECT {} ON COLUMNS FROM [${cube}]`,
        limit: 1,
      });
      expect(getCallgraphCacheStats()).toHaveLength(1);

      // A process write genuinely changes the reference graph: must invalidate.
      await h.ok("tm1_upsert_process", {
        processName: PROBE_PROC,
        prolog: "# audit live probe",
      });
      expect(getCallgraphCacheStats()).toHaveLength(0);
    });
  });

  // ---- T1: wire shape over a real payload --------------------------------
  describe("T1 — response mode", () => {
    it("legacy ships the body twice: text AND structuredContent", async () => {
      const r = await h.ok("tm1_get_server_info");
      expect(r.text).toBeTruthy();
      expect(r.result.structuredContent).toBeTruthy();
      expect(JSON.parse(r.text as string)).toEqual(r.result.structuredContent);
    });
  });
});
