import pino from "pino";
import type { TM1Config } from "./config.js";

// "Cookie"/"cookie" are defensive: the TM1SessionId travels as a Cookie header
// VALUE, which path-based redaction of the field name would miss. No code logs
// headers today, but a future logger.debug({ headers }) must not leak the session.
const SENSITIVE_FIELDS = ["password", "Authorization", "TM1SessionId", "Cookie", "cookie"];
const MASK_VALUE = "***";

function redactPaths(): string[] {
  const paths: string[] = [];
  for (const field of SENSITIVE_FIELDS) {
    paths.push(field);
    paths.push(`*.${field}`);
    paths.push(`headers.${field}`);
  }
  return paths;
}

export function createLogger(
  config: Pick<TM1Config, "logLevel" | "logFile">,
  // Test-only: inject an in-memory destination to assert on real output. When
  // omitted (production), logs go to stderr (+ optional file) via a transport.
  // Redaction is configured on the pino instance itself, so it applies to any
  // destination — tests that drive this function exercise the real mask config.
  destination?: pino.DestinationStream,
): pino.Logger {
  const options: pino.LoggerOptions = {
    level: config.logLevel,
    redact: {
      paths: redactPaths(),
      censor: MASK_VALUE,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (destination) {
    return pino(options, destination);
  }

  const targets: pino.TransportTargetOptions[] = [];

  // Always log to stderr so stdout stays clean for MCP stdio transport
  targets.push({
    target: "pino/file",
    options: { destination: 2 }, // fd 2 = stderr
    level: config.logLevel,
  });

  // Optional file output
  if (config.logFile) {
    targets.push({
      target: "pino/file",
      options: { destination: config.logFile },
      level: config.logLevel,
    });
  }

  return pino(options, pino.transport({ targets }));
}
