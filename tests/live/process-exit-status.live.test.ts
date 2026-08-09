// Live PROCESS EXIT STATUS tier: the measurement behind `ProcessOutcome`.
//
// `classifyExecution` groups TM1's six `ProcessExecuteStatusCode` members by
// ONE property — did the run's writes commit — and that property cannot be
// derived from the names. It was measured, and this suite is that measurement
// kept executable: for each TI exit path, write a marker cell in the Prolog,
// take the exit, then read the cell back. Status and marker together pin the
// mapping; a TM1 build that changes either fails here instead of silently
// making the classifier lie.
//
// Everything is created by this file under the `${SANDBOX}_EXIT` prefix (own
// dimensions, own cube, one throwaway process per case) and removed again, so
// no assertion leans on model state it did not build.
//
// COVERAGE: all six members of tm1.ProcessExecuteStatusCode are exercised here
// — CompletedSuccessfully (CLEAN), HasMinorErrors (CONSOL), QuitCalled (QUIT),
// CompletedWithMessages (ITEMREJECT), Aborted (ERROR, BADCUBE), RollbackCalled
// (ROLLBACK). Nothing in the enum is left to inference. What has NO live
// coverage is the classifier's `indeterminate` bucket: a response with no
// status code, or one carrying a code this build does not know. Neither can be
// provoked from a conformant server — they are the defensive branches, covered
// by unit tests (tests/unit/process-result-outcome.test.ts) only.
//
// `ProcessBreak` is deliberately not asserted. It reported
// `CompletedSuccessfully` when probed by hand (11.8) — the trap documented on
// the `succeeded` variant in src/types.ts — but a `ProcessBreak` in a Prolog
// with no data source and no loop is TM1 acting outside its documented
// context; pinning that here would assert an accident.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getHarness,
  LIVE_ENABLED,
  SANDBOX,
  type LiveHarness,
} from "./harness.js";

const PREFIX = `${SANDBOX}_EXIT`;
const DIM_A = `${PREFIX}_DA`;
const DIM_B = `${PREFIX}_DB`;
const CUBE = `${PREFIX}_CUBE`;
// Deliberately never created — a CellPutN into it is the "bad cube" abort.
// Sandbox-prefixed so the name cannot collide with a real model object.
const MISSING_CUBE = `${PREFIX}_NOSUCHCUBE`;

interface ExitCase {
  /** Suffix of the throwaway process name, and the row label. */
  name: string;
  /** TI appended after the marker write. */
  body: string;
  status: string;
  outcome: "succeeded" | "completed_with_errors" | "rolled_back";
  /** true = the marker write survived the exit (the run committed). */
  committed: boolean;
  /** Appended to every assertion message for this case (fixture sensitivities). */
  note?: string;
}

// Every failure here is a FINDING about the server, not a broken test — this
// suite is manual/nightly and never a PR gate, so it is allowed to be strict.
// The right response to a red case is to record what TM1 actually returned and
// work out what changed, never to relax the expectation until it passes.
const finding = (c: ExitCase, what: string): string =>
  [
    `${c.name}: TM1 disagreed with the measured mapping for ${what}.`,
    "This is a FINDING, not a broken test: record the actual value and the",
    "server version, then decide whether classifyExecution's grouping is still",
    "right. Do NOT relax this assertion to make it pass.",
    c.note ?? "",
  ]
    .filter(Boolean)
    .join(" ");

const EXIT_CASES: readonly ExitCase[] = [
  {
    name: "CLEAN",
    body: "",
    status: "CompletedSuccessfully",
    outcome: "succeeded",
    committed: true,
  },
  {
    name: "ITEMREJECT",
    body: "ItemReject('probe');",
    status: "CompletedWithMessages",
    outcome: "completed_with_errors",
    committed: true,
  },
  {
    name: "QUIT",
    body: "ProcessQuit;",
    status: "QuitCalled",
    outcome: "completed_with_errors",
    committed: true,
  },
  {
    name: "ERROR",
    body: "ProcessError;",
    status: "Aborted",
    outcome: "rolled_back",
    committed: false,
  },
  {
    name: "BADCUBE",
    body: `CellPutN(1, '${MISSING_CUBE}', 'E1', 'F1');`,
    status: "Aborted",
    outcome: "rolled_back",
    committed: false,
  },
  // HasMinorErrors — and the fixture detail below decides whether you get it.
  //
  // The DOCUMENTED path to minor errors is per-record failures in the Metadata
  // or Data tab, which only run when the process has a data source. This
  // fixture deliberately builds no data source, so that path cannot fire here
  // at all. The consolidated write is a Prolog-only shortcut that happens to
  // produce the same status code on v11 11.8 (measured) — it is how we reach
  // the member without a data source, NOT how minor errors normally arise.
  //
  // FRAGILE, and not in a footnote-sized way: which status this construct
  // returns depends on how the consolidation relates to the marker cell.
  //   - C1 rolls up a DIFFERENT leaf (E2) than the marker (E1) → HasMinorErrors,
  //     and the marker write COMMITS. That is this case.
  //   - C1 rolls up the SAME leaf the marker writes → Aborted, everything
  //     rolled back. Measured too, on the same server.
  // A future reader who "simplifies" the dimension to one leaf silently swaps
  // which status this case exercises — and would then be measuring Aborted a
  // third time while believing HasMinorErrors is covered.
  {
    name: "CONSOL",
    body: `CellPutN(7, '${CUBE}', 'C1', 'F1');`,
    status: "HasMinorErrors",
    outcome: "completed_with_errors",
    committed: true,
    note:
      "This case is fixture-sensitive: C1 must roll up E2, NOT the marker leaf E1. " +
      "With C1 over E1 the same construct returns Aborted with a full rollback.",
  },
  {
    name: "ROLLBACK",
    body: "ProcessRollback;",
    status: "RollbackCalled",
    outcome: "rolled_back",
    committed: false,
  },
];

describe.skipIf(!LIVE_ENABLED)(
  "live: TI exit status → commit semantics",
  () => {
    let h: LiveHarness;

    beforeAll(async () => {
      h = await getHarness();
      // Leftovers from an interrupted run (idempotent — missing objects are fine).
      await h.call("tm1_delete_cube", { cubeName: CUBE, confirm: CUBE });
      for (const d of [DIM_A, DIM_B]) {
        await h.call("tm1_delete_dimension", { dimensionName: d, confirm: d });
      }

      // tm1_create_dimension takes the name only; elements arrive via bulk upsert.
      await h.ok("tm1_create_dimension", { dimensionName: DIM_A });
      await h.ok("tm1_bulk_upsert_elements", {
        dimensionName: DIM_A,
        // E1 carries the marker. E2 exists ONLY so the consolidation below can
        // roll up a leaf that is not E1 — see the CONSOL case.
        elements: [
          { name: "E1", type: "Numeric" },
          { name: "E2", type: "Numeric" },
        ],
      });
      await h.ok("tm1_create_dimension", { dimensionName: DIM_B });
      await h.ok("tm1_bulk_upsert_elements", {
        dimensionName: DIM_B,
        elements: [{ name: "F1", type: "Numeric" }],
      });
      // C1 is the consolidation the CONSOL case writes into. Its single
      // component MUST be E2, not the marker leaf E1: over E2 the illegal write
      // returns HasMinorErrors and the marker commits; over E1 the very same
      // write returns Aborted and rolls everything back. Both measured on 11.8.
      await h.ok("tm1_bulk_upsert_elements", {
        dimensionName: DIM_A,
        elements: [
          {
            name: "C1",
            type: "Consolidated",
            components: [{ name: "E2", weight: 1 }],
          },
        ],
      });
      await h.ok("tm1_create_cube", {
        cubeName: CUBE,
        dimensions: [DIM_A, DIM_B],
      });
    });

    afterAll(async () => {
      for (const c of EXIT_CASES) {
        const proc = `${PREFIX}_${c.name}`;
        await h.call("tm1_delete_process", {
          processName: proc,
          confirm: proc,
        });
      }
      await h.call("tm1_delete_cube", { cubeName: CUBE, confirm: CUBE });
      for (const d of [DIM_A, DIM_B]) {
        await h.call("tm1_delete_dimension", { dimensionName: d, confirm: d });
      }
    });

    for (const c of EXIT_CASES) {
      it(`${c.name}: reports ${c.status} (${c.outcome}) and ${
        c.committed ? "keeps" : "discards"
      } the write`, async () => {
        const proc = `${PREFIX}_${c.name}`;

        // Reset the marker. Writing 0 EMPTIES the cell — TM1 does not store
        // zeros — so the post-run read is `null` unless this run's write
        // survived. That is why the rolled-back expectation below is null and
        // not 0.
        await h.ok("tm1_write_cells", {
          cubeName: CUBE,
          dimensions: [DIM_A, DIM_B],
          cells: [{ elements: ["E1", "F1"], value: 0 }],
          confirm: CUBE,
        });

        // Marker write FIRST, then the exit: whether 42 survives is the whole
        // question. CRLF because that is what TM1 stores.
        await h.ok("tm1_upsert_process", {
          processName: proc,
          prolog: `CellPutN(42, '${CUBE}', 'E1', 'F1');\r\n${c.body}\r\n`,
        });

        const run = await h.call("tm1_execute_process", {
          processName: proc,
          confirm: proc,
        });

        // The status is the raw server fact; the other three are what this
        // build derives from it. Assert the raw fact first so a red run names
        // what TM1 said, not what we concluded.
        expect(
          run.json?.processErrorStatus,
          finding(c, "the ProcessExecuteStatusCode"),
        ).toBe(c.status);
        // Only `succeeded` is a non-error result; everything else is fail-closed
        // via isError, which is exactly what `outcome` exists to qualify.
        expect(run.json?.outcome, finding(c, "the derived outcome")).toBe(
          c.outcome,
        );
        expect(run.json?.success, finding(c, "the success flag")).toBe(
          c.outcome === "succeeded",
        );
        expect(run.isError, finding(c, "the isError envelope")).toBe(
          c.outcome !== "succeeded",
        );

        const cell = await h.ok("tm1_get_cell_value", {
          cubeName: CUBE,
          elements: ["E1", "F1"],
        });
        // 42 = the Prolog write was committed. null = it was rolled back with
        // the run: the reset above emptied the cell, and TM1 stores no zeros,
        // so an unwritten cell reads back as null rather than 0.
        expect(
          cell.json?.value,
          finding(
            c,
            c.committed
              ? "whether the write COMMITTED (expected the marker 42 to survive)"
              : "whether the write ROLLED BACK (expected the cell to be empty)",
          ),
        ).toBe(c.committed ? 42 : null);

        await h.ok("tm1_delete_process", { processName: proc, confirm: proc });
      });
    }
  },
);
