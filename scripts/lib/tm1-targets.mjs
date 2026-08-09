// Shared credential plumbing for the local, network-bound scripts
// (`run-live-nightly.mjs`, `smoke-tarball.mjs`).
//
// One rule holds everywhere: credentials are NEVER read from a committed file.
// They come either from the caller's environment or from `.mcp.json`, which is
// git-ignored (see .gitignore) and holds one `env` block per MCP server — the
// same file the interactive MCP clients use, so a scripted run and a
// hand-driven session hit identical configuration.
//
// This module exists so there is exactly one redactor and one target resolver.
// A second copy is a second chance to forget a secret key.
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

/** Env keys whose VALUES are redacted from everything a script prints. */
export const SECRET_KEYS = [
  "TM1_PASSWORD",
  "TM1_CLIENT_SECRET",
  "TM1_CLIENT_ID",
  "TM1_ACCESS_TOKEN",
  "TM1_API_KEY",
  "TM1_CAM_PASSPORT",
];

/**
 * Resolve each target name to its TM1_* env block.
 *
 * "env" takes whatever TM1_* the caller exported. Every other name is an
 * `mcpServers` key in `.mcp.json`.
 *
 * `fail(message)` is supplied by the caller so each script can exit with its
 * own usage code instead of this module inventing one.
 */
export function resolveTargets(targetNames, mcpConfigPath, fail) {
  const needsFile = targetNames.some((t) => t !== "env");
  let servers = {};
  if (needsFile) {
    if (!existsSync(mcpConfigPath)) {
      fail(
        `No credential source at ${mcpConfigPath}.\n` +
          `  Either create it (git-ignored; one env block per MCP server),\n` +
          `  point --mcp-config at another file, or export TM1_BASE_URL /\n` +
          `  TM1_USER / TM1_PASSWORD yourself and run with --target=env.`,
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
    } catch (err) {
      fail(`Could not parse ${mcpConfigPath}: ${err.message}`);
    }
    servers = parsed.mcpServers ?? {};
  }

  return targetNames.map((name) => {
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
        `Target "${name}" is not in ${mcpConfigPath}. Available: ` +
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
 * Every TM1_* variable is dropped first, then the target's block is applied,
 * then `extra` on top. That strip is load-bearing, not hygiene theatre:
 * `loadConfig()` decides v11 vs v12 from the mere presence of TM1_INSTANCE /
 * TM1_DATABASE, so a leftover v12 variable — from the caller's shell or from
 * the previous target in the same run — silently reroutes a v11 target into
 * the v12 login path.
 *
 * DOTENV_CONFIG_PATH goes too: `src/load-env.ts` honors it explicitly, so an
 * ambient value would smuggle a whole `.env` back in behind the strip.
 */
export function childEnv(targetEnv, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("TM1_")) env[k] = v;
  }
  delete env.DOTENV_CONFIG_PATH;
  Object.assign(env, targetEnv, extra);
  return env;
}

/**
 * Literal-replacement redactor over every secret value in every target.
 *
 * Over-redaction is the intended failure mode: if a password happens to be a
 * substring of an otherwise-innocent line, that line loses the substring. A
 * mangled log beats a leaked credential.
 */
export function buildRedactor(targets) {
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
export function probe(baseUrl, { rejectUnauthorized, timeoutMs }) {
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
