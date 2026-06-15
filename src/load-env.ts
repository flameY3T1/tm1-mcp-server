import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Load environment from .env BEFORE any other module evaluates. MCP clients
// spawn this binary with THEIR working directory, not the repo's, so the plain
// `dotenv/config` (which only reads process.cwd()/.env) would never find a repo
// `.env` — the single most common first-run failure. We additionally resolve
// `.env` relative to the compiled entrypoint (dist/load-env.js -> ../.env, i.e.
// the package/repo root) so the documented clone+build setup works regardless of
// the client's cwd.
//
// dotenv never overwrites already-set keys, so precedence is:
//   real shell / MCP `env:` vars  >  cwd/.env  >  <packageRoot>/.env
//
// `quiet: true` is REQUIRED: dotenv v17 prints "injected env" tips to stdout by
// default, which would corrupt the JSON-RPC stream on the stdio transport.
loadDotenv({ quiet: true });
loadDotenv({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env"), quiet: true });
