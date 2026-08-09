#!/usr/bin/env node
// Scheduled live-suite runner (Tier 6 item 2).
//
// WHY THIS IS A LOCAL SCRIPT AND NOT A GITHUB ACTION
// The TM1 servers this project is developed against sit on a private network
// (the Windows host of a WSL box). A GitHub-hosted runner cannot route to
// them, and the live suites self-skip without credentials — so a scheduled
// workflow would produce a green check every night while verifying exactly
// nothing. A green check that means nothing is worse than no check, so there
// is no CI live job. Live coverage exists only when this script runs on a
// machine that can actually reach a TM1 server.
//
// WHAT IT DOES
// For each target: strip every TM1_* variable from the environment, apply that
// target's credentials, probe the server, run `vitest --config
// vitest.live.config.ts` against it, and append a section to one timestamped
// report. It exits non-zero on drift, and — crucially — reports "could not
// reach TM1" as its own outcome with its own exit code, because an unreachable
// box is not a contract regression and must never be filed as one.
//
//   npm run test:live:nightly                     # tm1-test (v11) + tm1-v12
//   npm run test:live:nightly -- --targets=tm1-test
//   npm run test:live:nightly -- --target=env     # use the ambient environment
//   npm run test:live:nightly -- --filter=process # narrow to matching files
//
// Exit codes (a scheduler can branch on these):
//   0  every selected target ran and passed
//   1  a target FAILED or timed out  → real contract drift, look at the report
//   2  usage / configuration error   → nothing was attempted
//   3  a target was unreachable or executed no tests, and nothing failed
//      → nothing was verified there. Deliberately not 0: a run that checked
//        nothing must not look like a pass. Pass --allow-unreachable to
//        downgrade this to 0 for schedulers that mail on non-zero.
//
// Credentials are NEVER read from a committed file. Either they are already in
// the environment (--target=env), or they come from .mcp.json, which is
// git-ignored (see .gitignore) and holds one env block per MCP server. Secret
// values are redacted from everything this script prints or writes.
import { spawn } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import http from "node:http";
import https from "node:https";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const EXIT_OK = 0;
const EXIT_DRIFT = 1;
const EXIT_USAGE = 2;
const EXIT_NOT_VERIFIED = 3;

// Default targets = the two servers this project is developed against. Note
// what is NOT here: tm1-prod. The live suite creates and deletes objects (in
// the ZZ_MCP_LIVE sandbox namespace, but still), so pointing the scheduled run
// at production has to be a deliberate, typed-out act.
const DEFAULT_TARGETS = ["tm1-test", "tm1-v12"];

// Values of these keys are redacted from the console and the report.
const SECRET_KEYS = [
  "TM1_PASSWORD",
  "TM1_CLIENT_SECRET",
  "TM1_CLIENT_ID",
  "TM1_ACCESS_TOKEN",
  "TM1_API_KEY",
  "TM1_CAM_PASSPORT",
];

// ---------------------------------------------------------------- arguments

function usage() {
  process.stdout.write(
    `Usage: node scripts/run-live-nightly.mjs [options]

  --targets=a,b        Comma-separated target names (default: ${DEFAULT_TARGETS.join(",")}).
  --target=NAME        Add one target; repeatable. "env" = use the ambient
                       environment instead of an .mcp.json entry.
  --mcp-config=PATH    Credential source (default: <repo>/.mcp.json, git-ignored).
  --out=DIR            Report directory (default: <repo>/.live-reports).
  --filter=SUBSTR      Passed to vitest as a test-file filter.
  --timeout-min=N      Per-target wall clock budget (default: 30).
  --probe-timeout=SEC  Reachability probe timeout (default: 10).
  --keep=N             Keep the newest N reports (default: 30; 0 = keep all).
  --allow-unreachable  Exit 0 instead of ${EXIT_NOT_VERIFIED} when a target was unreachable.
  -h, --help           This text.
`,
  );
}

function parseArgs(argv) {
  const opts = {
    targets: [],
    mcpConfig: join(ROOT, ".mcp.json"),
    out: join(ROOT, ".live-reports"),
    filter: undefined,
    timeoutMin: 30,
    probeTimeoutSec: 10,
    keep: 30,
    allowUnreachable: false,
  };
  for (const arg of argv) {
    const [key, ...rest] = arg.split("=");
    const value = rest.join("=");
    switch (key) {
      case "-h":
      case "--help":
        usage();
        process.exit(EXIT_OK);
        break;
      case "--targets":
        opts.targets.push(...value.split(",").filter(Boolean));
        break;
      case "--target":
        opts.targets.push(value);
        break;
      case "--mcp-config":
        opts.mcpConfig = resolve(value);
        break;
      case "--out":
        opts.out = resolve(value);
        break;
      case "--filter":
        opts.filter = value;
        break;
      case "--timeout-min":
        opts.timeoutMin = Number(value);
        break;
      case "--probe-timeout":
        opts.probeTimeoutSec = Number(value);
        break;
      case "--keep":
        opts.keep = Number(value);
        break;
      case "--allow-unreachable":
        opts.allowUnreachable = true;
        break;
      default:
        fail(`Unknown argument: ${arg}\nRun with --help.`);
    }
  }
  if (opts.targets.length === 0) opts.targets = [...DEFAULT_TARGETS];
  if (!Number.isFinite(opts.timeoutMin) || opts.timeoutMin <= 0) {
    fail("--timeout-min must be a positive number");
  }
  if (!Number.isFinite(opts.probeTimeoutSec) || opts.probeTimeoutSec <= 0) {
    fail("--probe-timeout must be a positive number");
  }
  return opts;
}

function fail(message) {
  process.stderr.write(`\n[live-nightly] ${message}\n`);
  process.exit(EXIT_USAGE);
}

// -------------------------------------------------------------- credentials

/**
 * Resolve each target to its TM1_* env block.
 *
 * "env" takes whatever TM1_* the caller exported. Every other name is an
 * mcpServers key in .mcp.json — the same file the interactive MCP servers use,
 * so a scheduled run and a hand-driven session hit identical configuration.
 */
function resolveTargets(opts) {
  const needsFile = opts.targets.some((t) => t !== "env");
  let servers = {};
  if (needsFile) {
    if (!existsSync(opts.mcpConfig)) {
      fail(
        `No credential source at ${opts.mcpConfig}.\n` +
          `  Either create it (git-ignored; one env block per MCP server),\n` +
          `  point --mcp-config at another file, or export TM1_BASE_URL /\n` +
          `  TM1_USER / TM1_PASSWORD yourself and run with --target=env.`,
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(opts.mcpConfig, "utf8"));
    } catch (err) {
      fail(`Could not parse ${opts.mcpConfig}: ${err.message}`);
    }
    servers = parsed.mcpServers ?? {};
  }

  return opts.targets.map((name) => {
    if (name === "env") {
      const env = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (k.startsWith("TM1_") && v !== undefined) env[k] = v;
      }
      return { name, env };
    }
    const server = servers[name];
    if (!server) {
      fail(
        `Target "${name}" is not in ${opts.mcpConfig}. Available: ` +
          `${Object.keys(servers).join(", ") || "(none)"}`,
      );
    }
    const env = {};
    for (const [k, v] of Object.entries(server.env ?? {})) {
      if (k.startsWith("TM1_") && typeof v === "string") env[k] = v;
    }
    return { name, env };
  });
}

/**
 * Child environment for one target.
 *
 * Every TM1_* variable is dropped first, then the target's block is applied.
 * That strip is load-bearing, not hygiene theatre: `loadConfig()` decides v11
 * vs v12 from the mere presence of TM1_INSTANCE / TM1_DATABASE, so a leftover
 * v12 variable — from the caller's shell or from the previous target in this
 * same run — silently reroutes a v11 target into the v12 login path.
 */
function childEnv(targetEnv) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("TM1_")) env[k] = v;
  }
  Object.assign(env, targetEnv);
  // Keep the suite's own output readable; the tests assert, they don't log.
  env.TM1_LOG_LEVEL = "error";
  env.CI = "1";
  return env;
}

/** Literal-replacement redactor over every secret value in every target. */
function buildRedactor(targets) {
  const values = new Set();
  for (const t of targets) {
    for (const key of SECRET_KEYS) {
      const v = t.env[key];
      // Short values (and the blank test-server password) are skipped: blanket
      // replacement of a 0–3 char string would shred unrelated output.
      if (typeof v === "string" && v.length >= 4) values.add(v);
    }
  }
  const sorted = [...values].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const v of sorted) out = out.split(v).join("«redacted»");
    return out;
  };
}

// ------------------------------------------------------------ reachability

/**
 * Is the server answering at all?
 *
 * This is the whole point of the preflight: "the box is off" and "the contract
 * drifted" are different events and must never share a status line. Any HTTP
 * status counts as alive (401 from an unauthenticated probe is the normal
 * answer). 502/503/504 mean the process is up but not serving yet — the TM1
 * test server does exactly this for a while after a cold start.
 */
function probe(baseUrl, { rejectUnauthorized, timeoutMs }) {
  return new Promise((done) => {
    let url;
    try {
      url = new URL(baseUrl);
    } catch {
      done({ state: "misconfigured", detail: `invalid TM1_BASE_URL` });
      return;
    }
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname || "/",
        method: "GET",
        timeout: timeoutMs,
        ...(url.protocol === "https:" ? { rejectUnauthorized } : {}),
      },
      (res) => {
        res.resume();
        const code = res.statusCode ?? 0;
        if (code === 502 || code === 503 || code === 504) {
          done({ state: "not-ready", detail: `HTTP ${code}` });
        } else {
          done({ state: "reachable", detail: `HTTP ${code}` });
        }
      },
    );
    req.on("timeout", () => {
      req.destroy();
      done({ state: "unreachable", detail: `no response in ${timeoutMs}ms` });
    });
    req.on("error", (err) => {
      const code = err.code ?? err.message;
      // A TLS rejection means the box answered — the run would fail on config,
      // not on drift, so it gets its own label.
      if (
        typeof code === "string" &&
        (code.includes("CERT") ||
          code.includes("SSL") ||
          code.startsWith("ERR_TLS"))
      ) {
        done({ state: "tls-blocked", detail: code });
      } else {
        done({ state: "unreachable", detail: String(code) });
      }
    });
    req.end();
  });
}

// -------------------------------------------------------------- the run

function runVitest({ env, filter, timeoutMs, jsonPath, onLine }) {
  const args = [
    join(ROOT, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "vitest.live.config.ts",
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${jsonPath}`,
  ];
  if (filter) args.push(filter);

  return new Promise((done) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, timeoutMs);

    // Line-buffered tee. Redaction happens per complete line, so a secret can
    // never be split across two chunks and slip past the replacement.
    const tee = () => {
      let residue = "";
      return {
        push(chunk) {
          residue += chunk;
          const lines = residue.split("\n");
          residue = lines.pop() ?? "";
          for (const line of lines) onLine(line);
        },
        flush() {
          if (residue) onLine(residue);
          residue = "";
        },
      };
    };
    const outTee = tee();
    const errTee = tee();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => outTee.push(c));
    child.stderr.on("data", (c) => errTee.push(c));

    child.on("error", (err) => {
      clearTimeout(killTimer);
      onLine(`[live-nightly] could not spawn vitest: ${err.message}`);
      done({ code: 127, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      outTee.flush();
      errTee.flush();
      done({ code: code ?? 1, timedOut });
    });
  });
}

/** Per-file tallies + failed test names from vitest's JSON reporter. */
function readJsonReport(path) {
  if (!existsSync(path)) return null;
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const files = [];
  const failedTests = [];
  for (const file of data.testResults ?? []) {
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    for (const t of file.assertionResults ?? []) {
      if (t.status === "passed") passed++;
      else if (t.status === "failed") {
        failed++;
        failedTests.push(`${shortPath(file.name)} › ${t.fullName ?? t.title}`);
      } else skipped++;
    }
    files.push({ file: shortPath(file.name), passed, failed, skipped });
  }
  return {
    files,
    failedTests,
    passed: data.numPassedTests ?? 0,
    failed: data.numFailedTests ?? 0,
    skipped: data.numPendingTests ?? data.numTodoTests ?? 0,
  };
}

function shortPath(p) {
  return String(p).startsWith(ROOT) ? String(p).slice(ROOT.length + 1) : p;
}

// Lines worth quoting when the run died before any assertion. Deliberately
// narrow — the goal is one line that tells auth apart from network, not a
// second copy of the vitest log (that is already in the report).
const HINT_RE =
  /(Error:|ERR_[A-Z_]+|ECONN\w*|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ENOTFOUND|Unauthorized|Forbidden|\b40[13]\b|\b50[0234]\b|certificate|self-signed)/i;

function collectHint(hints, rawLine) {
  if (hints.length >= 3) return;
  // Strip ANSI colour codes vitest emits so the report stays plain text.
  const line = rawLine.replace(/\u001b\[[0-9;]*m/g, "").trim();
  if (line.length < 8 || !HINT_RE.test(line)) return;
  // Two loud-but-uninformative shapes that would otherwise win the first slot
  // (the summary quotes hints[0]): the config warning, which contains "401" as
  // prose, and pino's JSON log lines, which repeat what the error already said.
  if (line.includes("WARNING") || line.startsWith("{")) return;
  const clipped = line.length > 200 ? `${line.slice(0, 200)}…` : line;
  if (!hints.includes(clipped)) hints.push(clipped);
}

// ------------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const targets = resolveTargets(opts);
  const redact = buildRedactor(targets);

  mkdirSync(opts.out, { recursive: true });
  const started = new Date();
  const stamp = started
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "Z");
  // `.log` so the report is covered by the existing `*.log` .gitignore rule
  // and ignored by prettier — a report must never show up as a repo diff.
  const reportPath = join(opts.out, `live-${stamp}.log`);

  const report = [];
  const say = (line) => {
    const clean = redact(line);
    report.push(clean);
    process.stdout.write(`${clean}\n`);
  };
  // Vitest chatter goes to the report only; the console keeps the summary.
  const quiet = (line) => report.push(redact(line));

  say(`# tm1-mcp-server live run — ${started.toISOString()}`);
  say(`# targets: ${targets.map((t) => t.name).join(", ")}`);
  say("");

  const results = [];

  for (const target of targets) {
    const baseUrl = target.env.TM1_BASE_URL;
    const label = `${target.name} (${baseUrl ?? "no TM1_BASE_URL"})`;
    say(`## ${label}`);

    if (!baseUrl || !target.env.TM1_USER) {
      // Without both, harness.ts sets LIVE_ENABLED=false and every suite
      // skips — which would otherwise read as a clean pass.
      say(
        `   MISCONFIGURED — TM1_BASE_URL and TM1_USER are both required; ` +
          `the suite would silently skip.`,
      );
      say("");
      results.push({ name: target.name, status: "MISCONFIGURED", detail: "" });
      continue;
    }

    const rejectUnauthorized =
      target.env.TM1_SSL_REJECT_UNAUTHORIZED !== "false";
    const pre = await probe(baseUrl, {
      rejectUnauthorized,
      timeoutMs: opts.probeTimeoutSec * 1000,
    });

    if (pre.state !== "reachable") {
      const status =
        pre.state === "not-ready"
          ? "NOT READY"
          : pre.state === "tls-blocked"
            ? "TLS BLOCKED"
            : pre.state === "misconfigured"
              ? "MISCONFIGURED"
              : "UNREACHABLE";
      say(`   ${status} — ${pre.detail}. No tests run; nothing verified.`);
      say("");
      results.push({ name: target.name, status, detail: pre.detail });
      continue;
    }
    say(`   reachable (${pre.detail}) — running live suite…`);

    const jsonPath = join(
      tmpdir(),
      `tm1-live-${target.name.replace(/\W+/g, "_")}-${stamp}.json`,
    );
    // Kept so a run that never reached a single assertion can still say WHY
    // (401 vs ECONNREFUSED vs TLS) instead of just "it was red".
    const hints = [];
    const t0 = Date.now();
    const { code, timedOut } = await runVitest({
      env: childEnv(target.env),
      filter: opts.filter,
      timeoutMs: opts.timeoutMin * 60_000,
      jsonPath,
      onLine: (line) => {
        quiet(line);
        collectHint(hints, line);
      },
    });
    const secs = Math.round((Date.now() - t0) / 1000);
    const summary = readJsonReport(jsonPath);
    rmSync(jsonPath, { force: true });

    const executed = summary ? summary.passed + summary.failed : 0;
    let status;
    let detail = "";

    if (timedOut) {
      status = "TIMEOUT";
      detail = `killed after ${opts.timeoutMin} min`;
    } else if (code !== 0) {
      // The server can die mid-run (these boxes get rebooted). A post-mortem
      // probe separates "TM1 went away" from "TM1 answered differently" —
      // filing the first as drift is how a report earns being ignored.
      const post = await probe(baseUrl, {
        rejectUnauthorized,
        timeoutMs: opts.probeTimeoutSec * 1000,
      });
      if (post.state === "unreachable" || post.state === "not-ready") {
        status = "LOST SERVER";
        detail = `server stopped answering mid-run (${post.detail}) — not drift`;
      } else if (executed === 0) {
        // Not one assertion ran, yet the run is red: the harness never got a
        // session (bad credentials, TLS, refused login, TM1 up but not
        // serving the API). The suites report as "skipped" in that state, so
        // without this branch it lands in FAIL and reads as drift — which is
        // exactly the conflation that trains people to ignore the report.
        status = "CONNECT FAILED";
        detail =
          hints.length > 0
            ? `never reached an assertion — ${hints[0]}`
            : "never reached an assertion (see report for vitest output)";
      } else {
        status = "FAIL";
        detail = `${summary?.failed ?? "?"} failing test(s)`;
      }
    } else if (executed === 0) {
      status = "NOTHING RAN";
      detail = "every suite skipped — nothing was verified";
    } else {
      status = "PASS";
    }

    if (summary) {
      say(
        `   ${summary.passed} passed · ${summary.failed} failed · ` +
          `${summary.skipped} skipped · ${secs}s`,
      );
      for (const f of summary.files.filter((f) => f.failed > 0)) {
        say(`   ✗ ${f.file} — ${f.failed} failed / ${f.passed} passed`);
      }
      if (status === "FAIL") {
        for (const name of summary.failedTests) say(`     · ${name}`);
      }
      if (status === "CONNECT FAILED") {
        for (const hint of hints.slice(0, 3)) say(`     · ${hint}`);
      }
    } else {
      say(`   no JSON report produced (vitest exit ${code}, ${secs}s)`);
    }
    say(`   => ${status}${detail ? ` — ${detail}` : ""}`);
    say("");
    results.push({ name: target.name, status, detail });
  }

  // ------------------------------------------------------------- verdict
  say("## summary");
  for (const r of results) {
    say(
      `   ${r.status.padEnd(14)} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`,
    );
  }

  const failed = results.filter(
    (r) => r.status === "FAIL" || r.status === "TIMEOUT",
  );
  const misconfigured = results.filter((r) => r.status === "MISCONFIGURED");
  const unverified = results.filter(
    (r) =>
      r.status === "UNREACHABLE" ||
      r.status === "NOT READY" ||
      r.status === "TLS BLOCKED" ||
      r.status === "LOST SERVER" ||
      r.status === "CONNECT FAILED" ||
      r.status === "NOTHING RAN",
  );

  let exitCode = EXIT_OK;
  if (misconfigured.length > 0) exitCode = EXIT_USAGE;
  if (failed.length > 0) exitCode = EXIT_DRIFT;
  else if (unverified.length > 0 && exitCode === EXIT_OK) {
    exitCode = opts.allowUnreachable ? EXIT_OK : EXIT_NOT_VERIFIED;
  }

  if (failed.length > 0) {
    say("");
    say(
      `!! DRIFT: ${failed.map((f) => f.name).join(", ")} — the failure output ` +
        `is in the report below.`,
    );
  } else if (unverified.length > 0) {
    say("");
    say(
      `!! NOT VERIFIED: ${unverified.map((f) => f.name).join(", ")} — this is ` +
        `NOT a pass. Nothing was checked against ${unverified.length > 1 ? "those servers" : "that server"}.`,
    );
  }

  writeFileSync(reportPath, `${report.join("\n")}\n`, "utf8");
  writeFileSync(join(opts.out, "latest.log"), `${report.join("\n")}\n`, "utf8");
  process.stdout.write(`\nreport: ${reportPath}\n`);

  pruneReports(opts.out, opts.keep);
  process.exit(exitCode);
}

function pruneReports(dir, keep) {
  if (!keep || keep <= 0) return;
  const files = readdirSync(dir)
    .filter((f) => /^live-\d{8}T\d{6}Z\.log$/.test(f))
    .sort()
    .reverse();
  for (const stale of files.slice(keep)) {
    rmSync(join(dir, stale), { force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`\n[live-nightly] unexpected error: ${err.stack}\n`);
  process.exit(EXIT_USAGE);
});
