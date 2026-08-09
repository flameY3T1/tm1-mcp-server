// Live validation for the 2026-08-09 performance/robustness fixes (P5, P8,
// P10) and the $batch counter-probe. The unit suites prove the logic against
// mocks; these prove the same paths behave against a real TM1 server.
//
// The counter-probe in particular CANNOT be reached through the tool layer: it
// only fires on an HTTP 400 from the FIRST $batch envelope on a connection, so
// it needs direct BatchService access and must run before any successful batch.
// That is why the probe block is first in this file, and why the file is meant
// to be run on its own:
//
//   npx vitest run --config vitest.live.config.ts tests/live/perf-fixes.live.test.ts
//
// Run inside the whole live suite it still passes, but the probe assertions
// self-skip because another file will have marked the connection supported.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getHarness,
  LIVE_ENABLED,
  SANDBOX,
  type LiveHarness,
} from "./harness.js";
import { BatchUnsupportedError } from "../../src/tm1-client/services/batch-service.js";

const PROBE_DIM = `${SANDBOX}_P8_DIM`;

describe.skipIf(!LIVE_ENABLED)("live: perf fixes 2026-08-09", () => {
  let h: LiveHarness;
  beforeAll(async () => {
    h = await getHarness();
  });

  afterAll(async () => {
    await h.call("tm1_delete_dimension", {
      dimensionName: PROBE_DIM,
      confirm: PROBE_DIM,
    });
  });

  // ---- $batch counter-probe: must run FIRST (needs an undecided tri-state) --
  describe("$batch counter-probe on an ambiguous 400", () => {
    it("does not mistake a payload-400 for a missing endpoint", async () => {
      if (h.client.batch.isKnownUnsupported) {
        console.log(
          "[probe] connection already marked unsupported — nothing to prove",
        );
        return;
      }

      // Duplicate correlation ids. The envelope is well-formed JSON but invalid
      // per the OData batch spec, so a server that HAS $batch rejects the whole
      // envelope with 400 — exactly the shape that used to be misread as
      // "this server has no $batch".
      let thrown: unknown;
      try {
        await h.client.batch.execute([
          { id: "dup", method: "GET", path: "/api/v1/Configuration" },
          { id: "dup", method: "GET", path: "/api/v1/Configuration" },
        ]);
      } catch (err) {
        thrown = err;
      }

      if (thrown === undefined) {
        // Server tolerated duplicate ids. Then this server cannot produce the
        // ambiguous case at all — report it rather than assert a false pass.
        console.log(
          "[probe] server accepted duplicate sub-request ids; no envelope-level 400 available here",
        );
        expect(h.client.batch.isKnownUnsupported).toBe(false);
        return;
      }

      console.log(
        `[probe] envelope rejected with: ${(thrown as Error).name}: ${(thrown as Error).message}`,
      );

      // The point of the fix: whatever went wrong, it must not have been
      // recorded as "no $batch on this server".
      expect(thrown).not.toBeInstanceOf(BatchUnsupportedError);
      expect(h.client.batch.isKnownUnsupported).toBe(false);
    });

    it("still serves a well-formed batch after the rejected one", async () => {
      if (h.client.batch.isKnownUnsupported) {
        console.log("[probe] connection unsupported — skipping");
        return;
      }
      const results = await h.client.batch.execute([
        {
          id: "r1",
          method: "GET",
          path: "/api/v1/Configuration/ProductVersion",
        },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("r1");
      console.log(
        `[probe] probe-path sub-status: ${results[0]!.status}, ok=${results[0]!.ok}`,
      );
      // The probe judges the ENVELOPE, not this status — a locked-down account
      // may legitimately be refused the read. Both outcomes prove $batch works.
      expect(typeof results[0]!.status).toBe("number");
    });
  });

  // ---- P10: narrow element-type read ---------------------------------------
  describe("P10 — getElementTypes reads Name,Type only", () => {
    it("returns name/type pairs for a real hierarchy", async () => {
      const dims = await h.ok("tm1_list_dimensions", { limit: 25 });
      const names: string[] = (dims.json.items ?? []).map(
        (d: { name: string }) => d.name,
      );
      if (names.length === 0) {
        // A bare v12 database has no user dimensions. Nothing to read types
        // from — the P8 block below still exercises getElementTypes against the
        // dimension it creates, so coverage is not lost.
        console.log("[P10] model has no user dimensions — nothing to type");
        return;
      }

      let checked = 0;
      for (const dim of names) {
        let elements;
        try {
          elements = await h.client.hierarchies.getElementTypes(dim, dim);
        } catch {
          continue; // alternate hierarchy naming or no read rights — try next
        }
        if (elements.length === 0) continue;
        for (const e of elements.slice(0, 50)) {
          expect(typeof e.name).toBe("string");
          expect(["Numeric", "Consolidated", "String"]).toContain(e.type);
        }
        console.log(`[P10] ${dim}: ${elements.length} elements typed`);
        checked++;
        break;
      }
      expect(checked).toBe(1);
    });
  });

  // ---- P5: consistency fan-out ---------------------------------------------
  describe("P5 — audit_complexity consistency scope fans out", () => {
    it("beats a serial walk of the same per-process reads", async () => {
      const list = await h.ok("tm1_list_processes", { limit: 500 });
      const procs: string[] = (list.json.items ?? []).map(
        (p: { name: string }) => p.name,
      );
      if (procs.length < 8) {
        console.log(`[P5] only ${procs.length} processes — timing not telling`);
        return;
      }

      // Measure one round-trip to get this server's per-call latency.
      const t0 = Date.now();
      await h.client.processes.getVariables(procs[0]!);
      const singleMs = Math.max(1, Date.now() - t0);

      const t1 = Date.now();
      const res = await h.ok("tm1_audit_complexity", {
        scope: ["consistency"],
      });
      const fanOutMs = Date.now() - t1;

      const serialEstimateMs = singleMs * procs.length;
      console.log(
        `[P5] ${procs.length} processes: single=${singleMs}ms, ` +
          `serial estimate=${serialEstimateMs}ms, actual=${fanOutMs}ms`,
      );
      expect(res.isError).toBe(false);
      // 8 in flight; allow generous slack for server-side contention and the
      // scope's own aggregation work, but a serial walk cannot land here.
      expect(fanOutMs).toBeLessThan(serialEstimateMs);
    });
  });

  // ---- P8: byte-capped chunking still upserts correctly --------------------
  describe("P8 — byte-capped $batch chunking", () => {
    it("bulk-upserts across chunk boundaries without loss", async () => {
      await h.ok("tm1_create_dimension", {
        dimensionName: PROBE_DIM,
        elements: [{ name: "Seed", type: "Numeric" }],
      });

      // Long names inflate per-sub-request bytes; 250 elements also crosses the
      // 200-request count cap, so both bounds are exercised in one call.
      const pad = "N".repeat(180);
      const elements = Array.from({ length: 250 }, (_, i) => ({
        name: `E${String(i).padStart(4, "0")}_${pad}`,
        type: "Numeric" as const,
      }));

      const up = await h.ok("tm1_bulk_upsert_elements", {
        dimensionName: PROBE_DIM,
        elements,
      });
      expect(up.isError).toBe(false);

      const typed = await h.client.hierarchies.getElementTypes(
        PROBE_DIM,
        PROBE_DIM,
      );
      const created = typed.filter((e) => e.name.startsWith("E")).length;
      console.log(`[P8] upserted 250, found ${created} back`);
      expect(created).toBe(250);
    });
  });
});
