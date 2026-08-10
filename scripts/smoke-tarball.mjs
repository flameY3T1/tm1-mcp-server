#!/usr/bin/env node
// Tarball smoke test — the only check in this repo that exercises the artefact
// a user actually installs.
//
// WHY THIS EXISTS
// `npm run verify` and the live suite both run against the TypeScript SOURCE.
// Neither has ever loaded `dist/`, and neither has ever seen the packed
// tarball: not the `bin` wiring, not the shebang, not the `files` allow-list,
// not the compiled entrypoint's startup path. That gap has bitten this project
// before — a stale `dist/` once masked an output-schema failure that the source
// tests were structurally unable to see. This script closes it by packing the
// real tarball, installing it into a throwaway project outside the repo, and
// driving the installed binary.
//
// It is deliberately NOT part of `npm run verify`: it packs, builds and hits
// the npm registry, which is far too slow for the normal gate. It belongs in
// RELEASING.md, immediately before `npm publish`.
//
// TWO TIERS
//   Tier 1 (always): pack → install → assert the bin entry resolves to
//     dist/index.js, assert the shebang, assert no secrets/sources leaked into
//     the tarball, then start the binary with NO TM1 configuration and assert
//     it dies with a readable configuration error instead of a stack-only
//     crash or a hang.
//   Tier 2 (only with credentials): a real MCP handshake over stdio against the
//     installed binary — initialize, notifications/initialized, tools/list, and
//     one READ-ONLY tools/call — asserting the wire contract (structuredContent
//     AND content[0].text both populated). Without a reachable target this tier
//     is SKIPPED, never failed.
//
//   npm run smoke:tarball                      # tier 1 + tier 2 vs tm1-test
//   npm run smoke:tarball -- --target=none     # tier 1 only
//   npm run smoke:tarball -- --target=env      # tier 2 vs the ambient env
//   npm run smoke:tarball -- --allow-skip      # a skipped tier 2 exits 0
//
// Exit codes (distinct on purpose — these are four different situations and
// collapsing them into 1 is how a release check stops being read):
//   0  tier 1 passed AND tier 2 ran and passed
//   1  tier 1 FAILED               → the installed artefact is broken
//   2  usage / configuration error → nothing was attempted
//   3  tier 1 passed, tier 2 NOT VERIFIED (no target configured, or the server
//      was unreachable). Deliberately not 0: nothing was checked against a real
//      server. --allow-skip downgrades it to 0.
//   4  pack or install FAILED      → there was no artefact to test
//   5  tier 2 FAILED               → handshake or 3.0.0 response-shape drift
//
// SECRETS
// Credentials are never read from a committed file — they come from the
// environment or from `.mcp.json` (git-ignored), exactly as
// scripts/run-live-nightly.mjs resolves them, via the shared helpers in
// scripts/lib/tm1-targets.mjs. Every line this script prints goes through that
// module's redactor. The throwaway install lives under os.tmpdir() and is
// removed on success and on failure, so a stray node_modules + tarball can
// never end up in the working tree.
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  buildRedactor,
  childEnv,
  probe,
  resolveTargets,
} from "./lib/tm1-targets.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const EXIT_OK = 0;
const EXIT_TIER1 = 1;
const EXIT_USAGE = 2;
const EXIT_NOT_VERIFIED = 3;
const EXIT_PACK = 4;
const EXIT_TIER2 = 5;

// Default tier-2 target = the test server. tm1-prod is deliberately NOT the
// default, for the same reason run-live-nightly.mjs excludes it from its
// DEFAULT_TARGETS: pointing an automated run at production has to be a
// deliberate, typed-out act. (This script also forces TM1_MODE=readonly, so it
// could not mutate a server even if aimed at one — belt and braces.)
const DEFAULT_TARGET = "tm1-test";

// The tier-2 tools/call. Must be read-only and cheap: it runs against a real
// server on every release.
const DEFAULT_TOOL = "tm1_get_server_info";

// Tar entries that must never appear inside the published tarball (npm prefixes
// every path with `package/`). `files` in package.json already restricts the
// contents to dist/ — this asserts the restriction actually held, because a
// broken `files` entry is how credentials reach the registry.
const FORBIDDEN_IN_TARBALL = [
  /^package\/\.env/,
  /^package\/\.mcp\.json$/,
  /^package\/\.npmrc$/,
  /^package\/src\//,
  /^package\/tests\//,
  /\.map$/,
];

// ---------------------------------------------------------------- arguments

function usage() {
  process.stdout.write(
    `Usage: node scripts/smoke-tarball.mjs [options]

  --target=NAME         Tier-2 target (default: ${DEFAULT_TARGET}). An mcpServers key
                        in .mcp.json, "env" for the ambient environment, or
                        "none" to run tier 1 only.
  --mcp-config=PATH     Credential source (default: <repo>/.mcp.json, git-ignored).
  --tool=NAME           Read-only tool for the tier-2 call (default: ${DEFAULT_TOOL}).
  --probe-timeout=SEC   Reachability probe budget (default: 10).
  --pack-timeout=SEC    npm pack budget (default: 300).
  --install-timeout=SEC npm install budget (default: 300).
  --start-timeout=SEC   Tier-1 no-config start budget (default: 30).
  --rpc-timeout=SEC     Per-JSON-RPC-response budget in tier 2 (default: 60).
  --allow-skip          Exit 0 instead of ${EXIT_NOT_VERIFIED} when tier 2 was skipped.
  --keep-tmp            Leave the throwaway install dir behind (debugging only).
  -h, --help            This text.
`,
  );
}

function parseArgs(argv) {
  const opts = {
    target: DEFAULT_TARGET,
    targetExplicit: false,
    mcpConfig: join(ROOT, ".mcp.json"),
    tool: DEFAULT_TOOL,
    probeTimeoutSec: 10,
    packTimeoutSec: 300,
    installTimeoutSec: 300,
    startTimeoutSec: 30,
    rpcTimeoutSec: 60,
    allowSkip: false,
    keepTmp: false,
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
      case "--target":
        opts.target = value;
        opts.targetExplicit = true;
        break;
      case "--mcp-config":
        opts.mcpConfig = resolve(value);
        break;
      case "--tool":
        opts.tool = value;
        break;
      case "--probe-timeout":
        opts.probeTimeoutSec = Number(value);
        break;
      case "--pack-timeout":
        opts.packTimeoutSec = Number(value);
        break;
      case "--install-timeout":
        opts.installTimeoutSec = Number(value);
        break;
      case "--start-timeout":
        opts.startTimeoutSec = Number(value);
        break;
      case "--rpc-timeout":
        opts.rpcTimeoutSec = Number(value);
        break;
      case "--allow-skip":
        opts.allowSkip = true;
        break;
      case "--keep-tmp":
        opts.keepTmp = true;
        break;
      default:
        fail(`Unknown argument: ${arg}\nRun with --help.`);
    }
  }
  const budgets = {
    "--probe-timeout": opts.probeTimeoutSec,
    "--pack-timeout": opts.packTimeoutSec,
    "--install-timeout": opts.installTimeoutSec,
    "--start-timeout": opts.startTimeoutSec,
    "--rpc-timeout": opts.rpcTimeoutSec,
  };
  for (const [flag, value] of Object.entries(budgets)) {
    if (!Number.isFinite(value) || value <= 0) {
      fail(`${flag} must be a positive number`);
    }
  }
  if (!opts.target) fail("--target needs a value (or use --target=none)");
  if (!opts.tool) fail("--tool needs a value");
  return opts;
}

function fail(message) {
  process.stderr.write(`\n[smoke-tarball] ${message}\n`);
  process.exit(EXIT_USAGE);
}

// ------------------------------------------------------------- process glue

/** Run a command to completion with a hard wall clock. Never inherits stdio. */
function run(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((done) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

/** Last non-empty lines of a blob — enough to explain a failure, not a dump. */
function tail(text, n = 8) {
  return text
    .split("\n")
    .map((l) => l.replace(/\[[0-9;]*m/g, "").trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(-n);
}

// ------------------------------------------------------- minimal MCP client
//
// A hand-rolled newline-delimited JSON-RPC client rather than the SDK's
// StdioClientTransport, on purpose: the point of this script is to test the
// installed package with as little of this repo's own code in the loop as
// possible.
//
// THE STDIN TRAP. src/index.ts shuts the server down on stdin `end`/`close`
// (that is how it notices the MCP client died). Writing every message and then
// closing stdin therefore races the server: it starts tearing down the TM1
// session while the async tools/call is still in flight, the response is never
// written, and a client that does not check for it sees silence and calls it a
// pass. So stdin stays open until the last response has actually arrived, and
// a missing response is an explicit failure below.
function startMcpClient({ bin, cwd, env, onStderrLine }) {
  const child = spawn(process.execPath, [bin], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const pending = new Map();
  const notifications = [];
  let exited = null;
  let outResidue = "";
  let errResidue = "";

  child.stdout.on("data", (chunk) => {
    outResidue += chunk;
    const lines = outResidue.split("\n");
    outResidue = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let msg;
      try {
        msg = JSON.parse(t);
      } catch {
        // Anything non-JSON on stdout corrupts the JSON-RPC stream. Surface it
        // rather than swallowing it — this is exactly the dotenv-banner class
        // of bug that load-env.ts guards against with `quiet: true`.
        notifications.push({ __nonJson: t });
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else {
        notifications.push(msg);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    errResidue += chunk;
    const lines = errResidue.split("\n");
    errResidue = lines.pop() ?? "";
    for (const line of lines) onStderrLine(line);
  });

  const exitPromise = new Promise((done) => {
    child.on("close", (code, signal) => {
      if (errResidue) {
        onStderrLine(errResidue);
        errResidue = "";
      }
      exited = { code, signal };
      // Anything still waiting will never be answered.
      for (const [, resolveFn] of pending) resolveFn(null);
      pending.clear();
      done(exited);
    });
  });

  const send = (msg) => {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  };

  /** Send a request and wait for ITS id. Resolves null on timeout or exit. */
  const request = (id, method, params, timeoutMs) =>
    new Promise((done) => {
      if (exited) {
        done(null);
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(id);
        done(null);
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        done(msg);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });

  const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

  /** Close stdin — and only now — then wait for the process to go away. */
  const shutdown = async (timeoutMs = 15_000) => {
    child.stdin.end();
    const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const result = await exitPromise;
    clearTimeout(killer);
    return result;
  };

  return { request, notify, shutdown, notifications };
}

// ---------------------------------------------------------------- reporting

let redact = (s) => s;
const say = (line) => process.stdout.write(`${redact(String(line))}\n`);

// ------------------------------------------------------------------ tier 1

/** npm pack + npm install into a throwaway project. Throws PackError. */
class PackError extends Error {}
class Tier1Error extends Error {}
class Tier2Error extends Error {}

async function packAndInstall(work, opts) {
  say(`## pack`);
  // `npm pack` triggers prepack (`rm -rf dist && npm run build`), so this is
  // the real compile of the real source — and it does wipe the developer's
  // working dist/. That is the point: no stale artefact can slip through.
  const packed = await run(
    "npm",
    ["pack", "--pack-destination", work, "--loglevel=error"],
    { cwd: ROOT, timeoutMs: opts.packTimeoutSec * 1000 },
  );
  if (packed.timedOut) {
    throw new PackError(`npm pack timed out after ${opts.packTimeoutSec}s`);
  }
  if (packed.code !== 0) {
    for (const l of tail(packed.stderr)) say(`   | ${l}`);
    throw new PackError(`npm pack exited ${packed.code}`);
  }
  const tarballName = packed.stdout.trim().split("\n").filter(Boolean).pop();
  const tarball = tarballName ? join(work, tarballName) : "";
  if (!tarball || !existsSync(tarball)) {
    throw new PackError(
      `npm pack produced no tarball (stdout: ${tarballName})`,
    );
  }
  const sizeKb = Math.round(lstatSync(tarball).size / 1024);
  say(`   ${tarballName} (${sizeKb} KB)`);

  // What actually shipped — read out of the real tarball, not from a second
  // `--dry-run` (which would re-run prepack and could describe a different
  // build). A `files` regression that pulls in .env or .mcp.json leaks
  // credentials to the registry, so this is checked before anything is run.
  const listed = await run("tar", ["-tzf", tarball], {
    timeoutMs: 60_000,
  });
  if (listed.code !== 0) {
    throw new PackError(
      `could not list the tarball: ${tail(listed.stderr, 1)}`,
    );
  }
  const entries = listed.stdout.split("\n").filter((l) => l.trim().length > 0);
  const offenders = entries.filter((p) =>
    FORBIDDEN_IN_TARBALL.some((re) => re.test(p)),
  );
  if (offenders.length > 0) {
    for (const o of offenders.slice(0, 10)) say(`   ! ${o}`);
    throw new PackError(
      `${offenders.length} forbidden path(s) in the tarball — check "files" in package.json`,
    );
  }
  say(`   ${entries.length} entries, no source/tests/maps/secrets`);
  say("");

  say(`## install`);
  // Fresh project, no lockfile, no dev deps — as close to what a user gets as
  // a sandboxed install can be.
  const proj = join(work, "consumer");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "package.json"),
    `${JSON.stringify(
      { name: "tm1-smoke-consumer", version: "0.0.0", private: true },
      null,
      2,
    )}\n`,
  );
  const install = await run(
    "npm",
    [
      "install",
      tarball,
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--loglevel=error",
    ],
    { cwd: proj, timeoutMs: opts.installTimeoutSec * 1000 },
  );
  if (install.timedOut) {
    throw new PackError(
      `npm install timed out after ${opts.installTimeoutSec}s`,
    );
  }
  if (install.code !== 0) {
    for (const l of tail(install.stderr)) say(`   | ${l}`);
    throw new PackError(`npm install exited ${install.code}`);
  }
  say(`   installed into ${proj}`);
  return { proj, tarball };
}

/** Everything that must hold for the INSTALLED package. Throws Tier1Error. */
async function tier1(proj, opts) {
  say(`## tier 1 — installed artefact`);

  // 1. The bin entry. npm creates node_modules/.bin/<name> from the "bin"
  //    field; a typo there means `npx tm1-mcp-server` is simply not a command,
  //    and no source test can see it.
  const binLink = join(proj, "node_modules", ".bin", "tm1-mcp-server");
  if (!existsSync(binLink)) {
    throw new Tier1Error(`no bin shim at node_modules/.bin/tm1-mcp-server`);
  }
  const binTarget = realpathSync(binLink);
  const expectedDir =
    join(proj, "node_modules", "tm1-mcp-server", "dist") + sep;
  if (!realpathSync(binTarget).startsWith(realpathSync(expectedDir))) {
    throw new Tier1Error(
      `bin shim resolves outside the installed package: ${binTarget}`,
    );
  }
  if (!binTarget.endsWith(`${sep}dist${sep}index.js`)) {
    throw new Tier1Error(
      `bin shim does not point at dist/index.js: ${binTarget}`,
    );
  }
  say(`   bin → ${binTarget.slice(proj.length + 1)}`);

  // 2. The shebang. Without it the shim is executed by the shell, not node,
  //    and the user gets a syntax-error salad from /bin/sh.
  const fd = openSync(binTarget, "r");
  const head = Buffer.alloc(64);
  const n = readSync(fd, head, 0, 64, 0);
  closeSync(fd);
  const firstLine = head.subarray(0, n).toString("utf8").split("\n")[0];
  if (firstLine !== "#!/usr/bin/env node") {
    throw new Tier1Error(
      `dist/index.js first line is ${JSON.stringify(firstLine)}, expected "#!/usr/bin/env node"`,
    );
  }
  say(`   shebang ok`);

  // 3. Version identity: the compiled entrypoint reads package.json at runtime
  //    (src/version.ts). If the tarball ever shipped without it, VERSION
  //    silently degrades to "unknown" and every MCP client sees a lie.
  const installedPkgPath = join(
    proj,
    "node_modules",
    "tm1-mcp-server",
    "package.json",
  );
  const installedPkg = JSON.parse(readFileSync(installedPkgPath, "utf8"));
  if (installedPkg.version !== PKG.version) {
    throw new Tier1Error(
      `installed version ${installedPkg.version} != repo version ${PKG.version}`,
    );
  }
  say(`   version ${installedPkg.version}`);

  // 4. Start with NO configuration at all. The contract is a readable
  //    configuration error and a prompt non-zero exit — not a hang (which
  //    leaves an MCP client spinning forever) and not a bare stack.
  // childEnv({}) strips every TM1_* variable (and DOTENV_CONFIG_PATH) from the
  // caller's shell. The child's cwd and package root are both under tmpdir(),
  // so load-env.ts finds no .env either — this really is an unconfigured start.
  const bareEnv = childEnv({});
  const started = Date.now();
  const noConfig = await run(process.execPath, [binTarget], {
    cwd: proj,
    env: bareEnv,
    timeoutMs: opts.startTimeoutSec * 1000,
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (noConfig.timedOut) {
    throw new Tier1Error(
      `unconfigured start HUNG — still alive after ${opts.startTimeoutSec}s ` +
        `(an MCP client would wait forever)`,
    );
  }
  if (noConfig.code === 0) {
    throw new Tier1Error(
      `unconfigured start exited 0 — a server with no TM1 target must fail`,
    );
  }
  const errText = noConfig.stderr;
  const wanted = ["TM1_BASE_URL", "TM1_USER", "TM1_PASSWORD"];
  const missingFromMessage = wanted.filter((w) => !errText.includes(w));
  if (
    !/Missing or empty required environment variables/i.test(errText) ||
    missingFromMessage.length > 0
  ) {
    for (const l of tail(errText)) say(`   | ${l}`);
    throw new Tier1Error(
      `unconfigured start did not name the missing configuration ` +
        `(absent from stderr: ${missingFromMessage.join(", ") || "message text"})`,
    );
  }
  // The diagnosis must be the FIRST thing on stderr. A stack trace above it
  // means the user has to read a crash dump to learn they forgot a variable.
  const firstErrLine = tail(errText, 200)[0] ?? "";
  if (!firstErrLine.includes("Missing or empty required environment")) {
    say(`   | ${firstErrLine}`);
    throw new Tier1Error(
      `stderr opens with something other than the configuration error`,
    );
  }
  if (noConfig.stdout.trim().length > 0) {
    for (const l of tail(noConfig.stdout, 3)) say(`   | stdout: ${l}`);
    throw new Tier1Error(
      `wrote to stdout while failing — that corrupts the JSON-RPC stream`,
    );
  }
  say(`   unconfigured start → exit ${noConfig.code} in ${secs}s, clear error`);
  say(`   => TIER 1 PASS`);
}

// ------------------------------------------------------------------ tier 2

async function tier2(proj, target, opts) {
  const binTarget = realpathSync(
    join(proj, "node_modules", ".bin", "tm1-mcp-server"),
  );

  // TM1_MODE=readonly is forced, not inherited: whatever .mcp.json says, this
  // script must be structurally incapable of mutating a server — in readonly
  // mode the write and destructive tools are never even registered.
  // TM1_RESPONSE_MODE is deleted rather than set, because the assertion below
  // is about the SHIPPED DEFAULT ("legacy"). Pinning it here would test the
  // flag and not the release.
  const env = childEnv(target.env, { TM1_MODE: "readonly" });
  delete env.TM1_RESPONSE_MODE;
  env.TM1_LOG_LEVEL = "error";

  const stderrLines = [];
  const client = startMcpClient({
    bin: binTarget,
    cwd: proj,
    env,
    onStderrLine: (l) => {
      if (l.trim()) stderrLines.push(l.trim());
    },
  });

  const rpcMs = opts.rpcTimeoutSec * 1000;
  const quote = () => {
    for (const l of stderrLines.slice(-4)) say(`   | ${l}`);
  };

  try {
    // --- initialize
    const init = await client.request(
      1,
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke-tarball", version: PKG.version },
      },
      rpcMs,
    );
    if (!init) {
      quote();
      throw new Tier2Error("no response to initialize");
    }
    if (init.error) {
      throw new Tier2Error(`initialize failed: ${JSON.stringify(init.error)}`);
    }
    const info = init.result?.serverInfo ?? {};
    if (info.name !== PKG.name || info.version !== PKG.version) {
      throw new Tier2Error(
        `serverInfo is ${info.name}@${info.version}, expected ${PKG.name}@${PKG.version}`,
      );
    }
    say(`   initialize → ${info.name}@${info.version}`);

    client.notify("notifications/initialized", {});

    // --- tools/list
    const list = await client.request(2, "tools/list", {}, rpcMs);
    if (!list) {
      quote();
      throw new Tier2Error("no response to tools/list");
    }
    if (list.error) {
      throw new Tier2Error(`tools/list failed: ${JSON.stringify(list.error)}`);
    }
    const tools = list.result?.tools ?? [];
    if (!Array.isArray(tools) || tools.length === 0) {
      throw new Tier2Error("tools/list returned no tools");
    }
    const names = tools.map((t) => t.name);
    if (!names.includes(opts.tool)) {
      throw new Tier2Error(`tools/list does not advertise ${opts.tool}`);
    }
    // readonly mode must not advertise anything that can write.
    const writable = tools.filter(
      (t) => t.annotations && t.annotations.readOnlyHint !== true,
    );
    if (writable.length > 0) {
      throw new Tier2Error(
        `TM1_MODE=readonly still advertises ${writable.length} non-read-only ` +
          `tool(s), e.g. ${writable[0].name}`,
      );
    }
    say(`   tools/list → ${tools.length} tools, all read-only`);

    // --- one read-only tools/call
    const call = await client.request(
      3,
      "tools/call",
      { name: opts.tool, arguments: {} },
      rpcMs,
    );
    // The trap this whole script was written around: no response at all is a
    // FAILURE, never a quiet pass.
    if (!call) {
      quote();
      throw new Tier2Error(
        `no response for tools/call id 3 (${opts.tool}) within ${opts.rpcTimeoutSec}s`,
      );
    }
    if (call.error) {
      throw new Tier2Error(
        `tools/call transport error: ${JSON.stringify(call.error)}`,
      );
    }
    const result = call.result ?? {};
    if (result.isError) {
      quote();
      throw new Tier2Error(
        `${opts.tool} returned an error result: ${JSON.stringify(result.content?.[0]?.text ?? result).slice(0, 300)}`,
      );
    }

    // --- the wire contract
    // The default ships the payload BOTH ways: as content[0].text and as
    // structuredContent. Asserting both halves against the packed tarball is
    // what catches a default flip that the source tests configure away — 3.0.0
    // shipped `content: []` and blanked every result on clients that read
    // content[] exclusively (Kiro's IDE).
    if (
      result.structuredContent === undefined ||
      result.structuredContent === null ||
      typeof result.structuredContent !== "object" ||
      Object.keys(result.structuredContent).length === 0
    ) {
      throw new Tier2Error(
        "structuredContent is empty — every tool declares an outputSchema, so it must be populated",
      );
    }
    const text = Array.isArray(result.content) ? result.content[0]?.text : null;
    if (typeof text !== "string" || text.length === 0) {
      throw new Tier2Error(
        `content[0].text is missing — TM1_RESPONSE_MODE default is not "legacy", ` +
          `so content-only clients would see an empty result. Got ` +
          `${JSON.stringify(result.content).slice(0, 200)}`,
      );
    }
    const keys = Object.keys(result.structuredContent).slice(0, 4).join(", ");
    say(
      `   tools/call ${opts.tool} → structuredContent{${keys}…}, content[0].text ${text.length} B`,
    );

    const nonJson = client.notifications.filter((n) => n.__nonJson);
    if (nonJson.length > 0) {
      say(`   | ${nonJson[0].__nonJson.slice(0, 160)}`);
      throw new Tier2Error("non-JSON output on stdout corrupted the stream");
    }

    say(`   => TIER 2 PASS`);
  } finally {
    // Only now is it safe to close stdin (see startMcpClient).
    await client.shutdown();
  }
}

// --------------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Resolve credentials BEFORE anything is printed, so the redactor is armed
  // for every subsequent line. A missing default target is a skip, not a
  // failure: a contributor without .mcp.json must still get tier 1.
  let target = null;
  let skipReason = null;
  if (opts.target === "none") {
    skipReason = "--target=none";
  } else if (opts.target === "env") {
    [target] = resolveTargets(["env"], opts.mcpConfig, fail);
    if (!target.env.TM1_BASE_URL || !target.env.TM1_USER) {
      target = null;
      skipReason = "no TM1_BASE_URL / TM1_USER in the environment";
    }
  } else if (!opts.targetExplicit && !existsSync(opts.mcpConfig)) {
    skipReason = `no ${opts.mcpConfig}`;
  } else {
    // An explicitly named target that does not exist is a usage error; the
    // default one merely being absent is a skip.
    const softFail = (msg) => {
      if (opts.targetExplicit) fail(msg);
      skipReason = `target "${opts.target}" is not in ${opts.mcpConfig}`;
      throw new SkipTarget();
    };
    try {
      [target] = resolveTargets([opts.target], opts.mcpConfig, softFail);
      if (!target.env.TM1_BASE_URL || !target.env.TM1_USER) {
        skipReason = `target "${opts.target}" has no TM1_BASE_URL / TM1_USER`;
        target = null;
      }
    } catch (err) {
      if (!(err instanceof SkipTarget)) throw err;
      target = null;
    }
  }
  redact = buildRedactor(target ? [target] : []);

  say(`# tm1-mcp-server tarball smoke — ${new Date().toISOString()}`);
  say(`# package ${PKG.name}@${PKG.version}`);
  say("");

  // Throwaway root under os.tmpdir(), NEVER inside the repo: a stray
  // node_modules plus a tarball in the working tree is how something
  // eventually gets committed by accident.
  const work = mkdtempSync(join(tmpdir(), "tm1-mcp-smoke-"));
  let exitCode = EXIT_OK;
  try {
    let proj;
    try {
      ({ proj } = await packAndInstall(work, opts));
    } catch (err) {
      if (!(err instanceof PackError)) throw err;
      say(`   => PACK/INSTALL FAILED — ${err.message}`);
      say("");
      say("## summary");
      say(`   PACK/INSTALL FAILED — nothing was verified`);
      return EXIT_PACK;
    }
    say("");

    try {
      await tier1(proj, opts);
    } catch (err) {
      if (!(err instanceof Tier1Error)) throw err;
      say(`   => TIER 1 FAIL — ${err.message}`);
      say("");
      say("## summary");
      say(`   TIER 1 FAILED — the installed artefact is broken`);
      return EXIT_TIER1;
    }
    say("");

    // ---- tier 2
    say(`## tier 2 — live MCP handshake`);
    if (!target) {
      say(`   SKIPPED, no target configured (${skipReason})`);
      say("");
      say("## summary");
      say(
        `   TIER 1 PASS · TIER 2 SKIPPED — nothing verified against a server`,
      );
      exitCode = opts.allowSkip ? EXIT_OK : EXIT_NOT_VERIFIED;
      return exitCode;
    }

    const baseUrl = target.env.TM1_BASE_URL;
    say(`   target ${target.name} (${baseUrl})`);
    const rejectUnauthorized =
      target.env.TM1_SSL_REJECT_UNAUTHORIZED !== "false";
    const pre = await probe(baseUrl, {
      rejectUnauthorized,
      timeoutMs: opts.probeTimeoutSec * 1000,
    });
    if (pre.state !== "reachable") {
      // Same rule as run-live-nightly.mjs: an unreachable box is not a
      // contract regression. It is also the only safe way to exercise this
      // path by hand — a deliberately wrong password would burn a login
      // attempt against a server with MaximumLoginAttempts.
      say(`   SKIPPED, target not reachable — ${pre.state} (${pre.detail})`);
      say("");
      say("## summary");
      say(
        `   TIER 1 PASS · TIER 2 NOT VERIFIED — ${target.name} ${pre.state} (${pre.detail})`,
      );
      return opts.allowSkip ? EXIT_OK : EXIT_NOT_VERIFIED;
    }

    try {
      await tier2(proj, target, opts);
    } catch (err) {
      if (!(err instanceof Tier2Error)) throw err;
      say(`   => TIER 2 FAIL — ${err.message}`);
      say("");
      say("## summary");
      say(`   TIER 1 PASS · TIER 2 FAILED — ${err.message}`);
      return EXIT_TIER2;
    }

    say("");
    say("## summary");
    say(`   TIER 1 PASS · TIER 2 PASS (${target.name})`);
    return EXIT_OK;
  } finally {
    // Cleanup on success AND on failure. The whole install lives in one
    // mkdtemp root, so a single rm is the entire teardown.
    if (opts.keepTmp) {
      say(`\n(kept ${work} — --keep-tmp)`);
    } else {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

/** Internal control-flow marker for "default target absent → skip". */
class SkipTarget extends Error {}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `\n[smoke-tarball] unexpected error: ${redact(String(err.stack ?? err))}\n`,
    );
    process.exit(EXIT_USAGE);
  });
