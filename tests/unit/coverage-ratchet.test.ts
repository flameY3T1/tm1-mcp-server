import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Guards scripts/check-coverage-ratchet.mjs — the CI gate that keeps the
// coverage floor honest in BOTH directions: it fails when coverage drops below
// the floor, and it also fails when coverage has grown so far above the floor
// that the floor no longer protects anything (the "ratchet up" nudge).
//
// The gate is a standalone .mjs invoked by npm/CI, so it is exercised the way
// CI runs it: spawned against synthetic fixture files.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const script = join(repoRoot, "scripts", "check-coverage-ratchet.mjs");
const realConfigPath = join(repoRoot, "coverage-thresholds.json");

type Metric = "lines" | "statements" | "functions" | "branches";
type Pcts = Record<Metric, number>;

const METRICS: Metric[] = ["lines", "statements", "functions", "branches"];

let workdir: string;
let seq = 0;

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), "cov-ratchet-"));
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function write(prefix: string, doc: unknown): string {
  const p = join(workdir, `${prefix}-${seq++}.json`);
  writeFileSync(p, JSON.stringify(doc), "utf8");
  return p;
}

/** Minimal istanbul json-summary payload with the given total percentages. */
function summaryFixture(pcts: Pcts, files: Record<string, number> = {}): string {
  const block = (pct: number) => ({
    total: 1000,
    covered: Math.round((pct / 100) * 1000),
    skipped: 0,
    pct,
  });
  const doc: Record<string, unknown> = {
    total: {
      lines: block(pcts.lines),
      statements: block(pcts.statements),
      functions: block(pcts.functions),
      branches: block(pcts.branches),
    },
  };
  for (const [file, pct] of Object.entries(files)) {
    doc[file] = {
      lines: { total: 200, covered: Math.round((pct / 100) * 200), skipped: 0, pct },
      statements: block(pct),
      functions: block(pct),
      branches: block(pct),
    };
  }
  return write("summary", doc);
}

const configFixture = (doc: unknown): string => write("config", doc);

interface RunResult {
  code: number;
  out: string;
}

function run(summary: string, config: string): RunResult {
  try {
    const out = execFileSync(process.execPath, [script, "--summary", summary, "--config", config], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** Floors 2 pts under a 60/60/60/60 fixture, slack 5 → the happy corridor. */
const BASE_CONFIG = {
  floors: { lines: 58, statements: 58, functions: 58, branches: 58 },
  slack: 5,
  headroomPoints: 2,
};

const EVEN = (pct: number): Pcts => ({
  lines: pct,
  statements: pct,
  functions: pct,
  branches: pct,
});

describe("coverage ratchet gate — passing cases", () => {
  it("passes when every metric sits inside [floor, floor + slack]", () => {
    const r = run(summaryFixture(EVEN(60)), configFixture(BASE_CONFIG));
    expect(r.code).toBe(0);
    expect(r.out).toContain("coverage ratchet OK");
  });

  it("passes exactly at the floor (boundary: at-floor is not below-floor)", () => {
    const r = run(summaryFixture(EVEN(58)), configFixture(BASE_CONFIG));
    expect(r.code).toBe(0);
  });

  it("passes at exactly floor + slack (boundary: not yet a ratchet)", () => {
    const r = run(summaryFixture(EVEN(63)), configFixture(BASE_CONFIG));
    expect(r.code).toBe(0);
  });

  it("prints the informational target without failing on it", () => {
    const r = run(
      summaryFixture(EVEN(60)),
      configFixture({ ...BASE_CONFIG, target: EVEN(99) }),
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("99%");
  });
});

describe("coverage ratchet gate — failing cases", () => {
  it("fails when a metric drops below its floor", () => {
    const r = run(
      summaryFixture({ lines: 57.99, statements: 60, functions: 60, branches: 60 }),
      configFixture(BASE_CONFIG),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("coverage BELOW floor");
    expect(r.out).toContain("lines");
  });

  it("refuses to suggest lowering the floor on a drop", () => {
    const r = run(summaryFixture(EVEN(40)), configFixture(BASE_CONFIG));
    expect(r.code).toBe(1);
    expect(r.out).toContain("Do NOT lower the floor");
  });

  it("names the weakest files of meaningful size on a drop", () => {
    const r = run(
      summaryFixture(EVEN(40), {
        "/repo/src/tools/thin-wrapper.ts": 3.5,
        "/repo/src/lib/well-tested.ts": 98,
      }),
      configFixture(BASE_CONFIG),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("thin-wrapper.ts");
  });

  it("fails when coverage climbed more than slack above the floor", () => {
    const r = run(summaryFixture(EVEN(80)), configFixture(BASE_CONFIG));
    expect(r.code).toBe(1);
    expect(r.out).toContain("Lock the gain in");
  });

  it("prints the exact new floors to paste when ratcheting up", () => {
    const r = run(
      summaryFixture({ lines: 80.4, statements: 79.6, functions: 70.2, branches: 66.9 }),
      configFixture(BASE_CONFIG),
    );
    expect(r.code).toBe(1);
    // suggested = floor(pct) - headroomPoints(2)
    expect(r.out).toContain('"lines": 78');
    expect(r.out).toContain('"statements": 77');
    expect(r.out).toContain('"functions": 68');
    expect(r.out).toContain('"branches": 64');
  });

  it("never suggests a floor below the current one", () => {
    // branches sits exactly at its floor while the rest shot up: the suggested
    // branches floor must stay 58, not slide down to 56.
    const r = run(
      summaryFixture({ lines: 90, statements: 90, functions: 90, branches: 58 }),
      configFixture(BASE_CONFIG),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain('"branches": 58');
  });
});

describe("coverage ratchet gate — bad input", () => {
  it("exits 2 with a run hint when the coverage summary is missing", () => {
    const r = run(join(workdir, "does-not-exist.json"), configFixture(BASE_CONFIG));
    expect(r.code).toBe(2);
    expect(r.out).toContain("coverage summary not found");
    expect(r.out).toContain("npm run coverage:check");
  });

  it("exits 2 when the summary has no total block", () => {
    const r = run(write("summary", { "/repo/src/a.ts": {} }), configFixture(BASE_CONFIG));
    expect(r.code).toBe(2);
    expect(r.out).toContain('no "total" block');
  });

  it("exits 2 when a floor is missing from the config", () => {
    const r = run(
      summaryFixture(EVEN(60)),
      configFixture({ floors: { lines: 58, statements: 58, functions: 58 }, slack: 5 }),
    );
    expect(r.code).toBe(2);
    expect(r.out).toContain('"floors.branches"');
  });

  it("exits 2 on an unknown argument", () => {
    let code = 0;
    try {
      execFileSync(process.execPath, [script, "--nope"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      code = (err as { status?: number }).status ?? -1;
    }
    expect(code).toBe(2);
  });
});

describe("coverage-thresholds.json (the checked-in config)", () => {
  const cfg = JSON.parse(readFileSync(realConfigPath, "utf8")) as {
    floors: Pcts;
    slack: number;
    headroomPoints: number;
    target?: Pcts;
  };

  it("declares a numeric floor for every metric the gate enforces", () => {
    for (const m of METRICS) expect(typeof cfg.floors[m]).toBe("number");
  });

  it("is accepted by the gate for a summary just above each floor", () => {
    const pcts = Object.fromEntries(METRICS.map((m) => [m, cfg.floors[m] + 1])) as Pcts;
    const r = run(summaryFixture(pcts), realConfigPath);
    expect(r.code).toBe(0);
  });

  it("meets the 50% pre-2.1 review floor for lines and statements", () => {
    expect(cfg.floors.lines).toBeGreaterThanOrEqual(50);
    expect(cfg.floors.statements).toBeGreaterThanOrEqual(50);
  });

  it("keeps every target at or above its floor", () => {
    if (!cfg.target) return;
    for (const m of METRICS) expect(cfg.target[m]).toBeGreaterThanOrEqual(cfg.floors[m]);
  });
});
