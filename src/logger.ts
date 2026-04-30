import pino from "pino";
import type { TM1Config } from "./config.js";

const SENSITIVE_FIELDS = ["password", "Authorization", "TM1SessionId"];
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
  config: Pick<TM1Config, "logLevel" | "logFile">
): pino.Logger {
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

  const transport = pino.transport({ targets });

  return pino(
    {
      level: config.logLevel,
      redact: {
        paths: redactPaths(),
        censor: MASK_VALUE,
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    transport
  );
}
