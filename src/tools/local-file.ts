import path from "node:path";
import { TM1Error, TM1ErrorCode } from "../types.js";

const ROOT_ENV = "TM1_LOCAL_FILE_ROOT";

/**
 * Confine a caller-supplied host filesystem path to the directory configured via
 * `TM1_LOCAL_FILE_ROOT`.
 *
 * Host-file access (the `filePath` / `writeToFile` / `directory` parameters on the
 * `.pro` round-trip tools) is DISABLED by default: without the env var set, those
 * tools only accept inline `content`. This keeps arbitrary host file read/write off
 * the default (readonly) tool surface — a prompt-injected agent cannot coerce the
 * server into reading `/proc/self/environ` (which would leak TM1 credentials),
 * `~/.ssh/id_rsa`, or writing to arbitrary locations.
 *
 * When the root IS configured, the resolved absolute path must stay within it; any
 * `..` traversal or absolute escape is rejected. Returns the resolved absolute path.
 */
export function resolveLocalPath(inputPath: string, paramName = "filePath"): string {
  const root = process.env[ROOT_ENV]?.trim();
  if (!root) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message:
        `Host-file access is disabled. Set ${ROOT_ENV} to an allowed directory to enable ` +
        `'${paramName}', or pass the .pro content inline via the 'content' parameter instead.`,
    });
  }
  if (!path.isAbsolute(inputPath)) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: `${paramName} must be absolute: ${inputPath}`,
    });
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(inputPath);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: `${paramName} escapes the allowed ${ROOT_ENV} directory (${resolvedRoot}): ${inputPath}`,
    });
  }
  return resolved;
}
