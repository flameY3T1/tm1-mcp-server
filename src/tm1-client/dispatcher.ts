// Per-request TLS dispatcher for TM1 fetches. Replaces the previous
// `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"` global side-effect, which
// disabled TLS verification for the entire Node process (including unrelated
// HTTPS calls from MCP transport, telemetry, etc.). With undici's Agent we
// scope `rejectUnauthorized: false` to TM1 fetches only.
//
// The Agent is cached so connection-pooling stays effective across requests.
import { Agent } from "undici";
import type { TM1Config } from "../config.js";

let cachedAgent: Agent | undefined;

export function getTm1Dispatcher(config: TM1Config): Agent | undefined {
  if (config.ssl.rejectUnauthorized) return undefined;
  if (!cachedAgent) {
    cachedAgent = new Agent({ connect: { rejectUnauthorized: false } });
  }
  return cachedAgent;
}
