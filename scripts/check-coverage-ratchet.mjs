#!/usr/bin/env node
// Coverage ratchet gate.
//
// vitest already fails the run when coverage drops below the floors in
// coverage-thresholds.json (`test.coverage.thresholds` reads the same file).
// That is only half a ratchet: it stops coverage from falling, but nothing
// stops the floor from rotting. This repo shipped floors of ~22% set in
// 2026-05 while real coverage had grown past 65% — a 40-point hole in which a
// large regression could land unnoticed.
//
// This script closes that hole. It reads the istanbul `json-summary` report
// and fails when either side of the ratchet is violated:
//
//   * BELOW FLOOR    — actual < floor (defence in depth; vitest trips first in
//                      the normal `coverage:check` chain, but this gate also
//                      runs standalone against a stored summary).
//   * SLACK EXCEEDED — actual - floor > slack. Coverage grew; the floor must
//                      be ratcheted up so the new level is protected. The
//                      failure prints the exact JSON to paste.
//
// Usage:
//   node scripts/check-coverage-ratchet.mjs
//   node scripts/check-coverage-ratchet.mjs --summary <path> --config <path>
//
// Exit codes:
//   0  every metric sits inside [floor, floor + slack]
//   1  a metric is below its floor, or a floor needs ratcheting up
//   2  bad invocation / missing or malformed input files
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const METRICS = ["lines", "statements", "functions", "branches"];

const pad = (s, n) => String(s).padStart(n);
const round2 = (n) => Math.round(n * 100) / 100;

function fail2(msg) {
  console.error(`check-coverage-ratchet: ${msg}`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = {
    summary: join(root, "coverage", "coverage-summary.json"),
    config: join(root, "coverage-thresholds.json"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--summary" || a === "--config") {
      const v = argv[++i];
      if (v === undefined) fail2(`${a} requires a path argument.`);
      out[a.slice(2)] = isAbsolute(v) ? v : join(process.cwd(), v);
    } else {
      fail2(`unknown argument: ${a}`);
    }
  }
  return out;
}

function readJson(path, what) {
  if (!existsSync(path)) {
    fail2(
      `${what} not found at ${path}.\n` +
        `  The gate needs the istanbul json-summary report. Run:\n` +
        `    npm run coverage:check   (vitest --coverage, then this gate)`,
    );
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail2(`${what} at ${path} is not valid JSON: ${String(err?.message ?? err)}`);
  }
}

// Point at the biggest wins: files with real size and the worst line coverage.
function printWeakestFiles(sum) {
  const files = Object.entries(sum)
    .filter(([k, v]) => k !== "total" && typeof v?.lines?.pct === "number")
    .map(([k, v]) => ({ file: k, pct: v.lines.pct, size: v.lines.total }))
    .filter((f) => f.size >= 20)
    .sort((a, b) => a.pct - b.pct || b.size - a.size)
    .slice(0, 5);
  if (files.length === 0) return;
  console.error(`\nLowest-covered files of meaningful size (lines %):`);
  for (const f of files) {
    const rel = f.file.startsWith(root) ? relative(root, f.file) : f.file;
    console.error(`  - ${pad(f.pct.toFixed(1) + "%", 6)}  ${rel}  (${f.size} lines)`);
  }
}

const args = parseArgs(process.argv.slice(2));
const config = readJson(args.config, "threshold config");
const summary = readJson(args.summary, "coverage summary");

// ── validate inputs ─────────────────────────────────────────────────────────
const floors = config.floors;
if (floors === null || typeof floors !== "object") {
  fail2(`threshold config is missing a "floors" object.`);
}
const slack = typeof config.slack === "number" ? config.slack : 5;
const headroom = typeof config.headroomPoints === "number" ? config.headroomPoints : 2;
const target = config.target ?? null;

for (const m of METRICS) {
  if (typeof floors[m] !== "number") {
    fail2(`threshold config "floors.${m}" is missing or not a number.`);
  }
}

const total = summary.total;
if (total === null || typeof total !== "object") {
  fail2(`coverage summary has no "total" block — is this an istanbul json-summary report?`);
}
for (const m of METRICS) {
  if (typeof total[m]?.pct !== "number") {
    fail2(`coverage summary "total.${m}.pct" is missing or not a number.`);
  }
}

// ── evaluate ────────────────────────────────────────────────────────────────
const rows = METRICS.map((metric) => {
  const pct = total[metric].pct;
  const floor = floors[metric];
  const drift = round2(pct - floor);
  let status = "ok";
  if (pct < floor) status = "below";
  else if (drift > slack) status = "ratchet";
  return {
    metric,
    pct,
    floor,
    drift,
    status,
    covered: total[metric].covered,
    count: total[metric].total,
    suggested: Math.max(floor, Math.floor(pct) - headroom),
  };
});

const below = rows.filter((r) => r.status === "below");
const ratchet = rows.filter((r) => r.status === "ratchet");

// ── report ──────────────────────────────────────────────────────────────────
const mark = { ok: "✓", below: "✖", ratchet: "▲" };

console.log("Coverage ratchet");
console.log(
  `  metric        actual   floor    drift` +
    (target ? "    target" : "") +
    `   covered   (slack ${slack} pts)`,
);
for (const r of rows) {
  const t = target && typeof target[r.metric] === "number" ? pad(`${target[r.metric]}%`, 10) : "";
  console.log(
    `  ${mark[r.status]} ${r.metric.padEnd(11)} ${pad(r.pct.toFixed(2) + "%", 7)} ` +
      `${pad(r.floor + "%", 6)} ${pad((r.drift >= 0 ? "+" : "") + r.drift.toFixed(2), 8)}` +
      `${t}   ${r.covered}/${r.count}`,
  );
}

if (below.length === 0 && ratchet.length === 0) {
  console.log(`✓ coverage ratchet OK — every metric within [floor, floor + ${slack}].`);
  process.exit(0);
}

if (below.length > 0) {
  console.error(`\n✖ coverage BELOW floor:`);
  for (const r of below) {
    console.error(
      `  - ${r.metric}: ${r.pct.toFixed(2)}% < floor ${r.floor}% ` +
        `(short by ${(r.floor - r.pct).toFixed(2)} pts)`,
    );
  }
  printWeakestFiles(summary);
  console.error(
    `\nFix: add tests for the code you changed. Do NOT lower the floor in\n` +
      `     coverage-thresholds.json to make this pass.`,
  );
}

if (ratchet.length > 0) {
  console.error(
    `\n▲ coverage ratchet: coverage grew more than ${slack} pts above the floor.\n` +
      `  Lock the gain in — the floor exists to protect it.`,
  );
  for (const r of ratchet) {
    console.error(
      `  - ${r.metric}: ${r.pct.toFixed(2)}% vs floor ${r.floor}% (+${r.drift.toFixed(2)} pts)`,
    );
  }
  const next = Object.fromEntries(rows.map((r) => [r.metric, r.suggested]));
  console.error(`\nFix: set "floors" in coverage-thresholds.json to:\n`);
  console.error(`  "floors": ${JSON.stringify(next, null, 4).replace(/\n/g, "\n  ")}\n`);
}

process.exit(1);
