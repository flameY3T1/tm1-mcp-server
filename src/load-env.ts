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
// `DOTENV_CONFIG_PATH` is honored explicitly: dotenv only reads that variable
// during Node preloading (`node --require dotenv/config`), NOT on a manual
// `config()` call, so an MCP client that sets it would otherwise fail silently.
//
// dotenv never overwrites already-set keys, so precedence is:
//   real shell / MCP `env:` vars  >  $DOTENV_CONFIG_PATH  >  cwd/.env  >  <packageRoot>/.env
//
// `quiet: true` is REQUIRED: dotenv v17 prints "injected env" tips to stdout by
// default, which would corrupt the JSON-RPC stream on the stdio transport.
if (process.env.DOTENV_CONFIG_PATH) {
  loadDotenv({ path: process.env.DOTENV_CONFIG_PATH, quiet: true });
}
loadDotenv({ quiet: true });
loadDotenv({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env"), quiet: true });
