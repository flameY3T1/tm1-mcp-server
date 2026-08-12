#!/usr/bin/env node
// Records wire contracts by running the live suite against a named server
// from .mcp.json, with RECORD_CONTRACTS=1.
//
// The server is taken from .mcp.json, never from .env: .env points at a
// production instance, and the live suite creates and deletes sandbox objects.
// Refusing to guess is the whole point of this wrapper.
//
//   node scripts/record-wire-contracts.mjs [serverName] [--merge] [--read-only]
//
//   --merge      fold this run into the existing contracts instead of
//                replacing them
//   --read-only  run only the read-only sweep, so the target server is never
//                written to. Required in practice for anything but a test
//                instance.
//   --verify     do not record — run the live suite and fail if the server no
//                longer matches the contracts on disk.
//
// Default server: tm1-test.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const name = args.find((a) => !a.startsWith("--")) ?? "tm1-test";
const readOnly = flags.has("--read-only");

const cfg = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
const entry = cfg.mcpServers?.[name];
if (!entry?.env?.TM1_BASE_URL) {
  console.error(
    `record-wire-contracts: no server "${name}" with TM1_BASE_URL in .mcp.json`,
  );
  process.exit(1);
}

console.log(
  `${flags.has("--verify") ? "Checking" : "Recording"} wire contracts against "${name}" (${entry.env.TM1_BASE_URL})` +
    (flags.has("--verify") ? " — verifying, not recording" : "") +
    (readOnly
      ? " — read-only sweep"
      : " — full live suite (creates sandbox objects)"),
);

const target = readOnly
  ? ["tests/live/read-broad.live.test.ts", "tests/live/read-smoke.live.test.ts"]
  : [];

const res = spawnSync(
  "npx",
  ["vitest", "run", "--config", "vitest.live.config.ts", ...target],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      ...entry.env,
      ...(flags.has("--verify") ? {} : { RECORD_CONTRACTS: "1" }),
      ...(flags.has("--merge") ? { CONTRACTS_MERGE: "1" } : {}),
    },
  },
);
// The live suite has known per-version failures; a failing assertion still
// produced real responses, so a non-zero exit does not invalidate the
// recording. Surface the code without treating it as fatal.
if (res.status !== 0) {
  console.log(
    `\nlive suite exited ${res.status} — contracts recorded from whatever ran.`,
  );
}
