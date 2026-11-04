// Loads the repo .env for the live suite ONLY when the environment names no
// target yet. The nightly runner strips every TM1_* variable and applies one
// target's block; plain `dotenv/config` would then fill every key that block
// leaves out from .env — which points at PROD (e.g. TM1_PASSWORD into a v12
// run). A configured target is used as-is, never mixed with .env.
// Imported first by harness.ts so the env is final before other modules load.
import { config } from "dotenv";

if (!process.env.TM1_BASE_URL) config({ quiet: true });
