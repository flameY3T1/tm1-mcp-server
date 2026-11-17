import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { TM1Error, TM1ErrorCode } from "../types.js";

const ROOT_ENV = "TM1_LOCAL_FILE_ROOT";

/**
 * Resolve symlinks as deeply as the filesystem allows: realpath the nearest
 * EXISTING ancestor (the target itself may not exist yet — write paths are
 * confined before the file is created), then re-append the not-yet-existing
 * tail lexically. Walks up one component at a time until realpathSync stops
 * throwing; at worst it terminates at the filesystem root.
 */
function realpathNearestExisting(p: string): string {
  let current = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : path.join(real, ...tail);
    } catch {
      // A link whose target does not exist yet is not a missing file: a write
      // follows it and creates the target, wherever that is.
      if (isSymlink(current)) {
        throw new TM1Error({
          code: TM1ErrorCode.VALIDATION_ERROR,
          message: `Path goes through a symbolic link that cannot be resolved: ${current}`,
        });
      }
      const parent = path.dirname(current);
      if (parent === current) {
        // Nothing on the path exists (not even "/", practically unreachable);
        // fall back to the lexical path so the caller's check still runs.
        return path.join(current, ...tail);
      }
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

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
 * The variable may name several roots separated by `;` — a path inside any one
 * of them is accepted.
 */
export function resolveLocalPath(
  inputPath: string,
  paramName = "filePath",
): string {
  // `;` separates several roots on every platform: `:` is part of a Windows
  // drive letter, so path.delimiter would not read the same on both.
  const roots = (process.env[ROOT_ENV] ?? "")
    .split(";")
    .map((r) => r.trim())
    .filter((r) => r !== "")
    .map((r) => path.resolve(r));
  if (roots.length === 0) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message:
        `Host-file access is disabled. Set ${ROOT_ENV} to an allowed directory to enable ` +
        `'${paramName}', or pass the content inline where the tool takes it.`,
    });
  }
  if (!path.isAbsolute(inputPath)) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: `${paramName} must be absolute: ${inputPath}`,
    });
  }
  const resolved = path.resolve(inputPath);
  const allowed = roots.join("; ");
  if (!roots.some((root) => isWithin(root, resolved))) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: `${paramName} escapes the allowed ${ROOT_ENV} directory (${allowed}): ${inputPath}`,
    });
  }
  // Symlink-safe second check: the lexical check above is bypassable by a
  // symlink placed INSIDE the root that points outside it. Compare real paths
  // instead — and realpath the root too, since the root itself may
  // legitimately be a symlink (e.g. /tmp on some systems).
  const realResolved = realpathNearestExisting(resolved);
  if (
    !roots.some((root) => isWithin(realpathNearestExisting(root), realResolved))
  ) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message:
        `${paramName} escapes the allowed ${ROOT_ENV} directory (${allowed}) ` +
        `after resolving symlinks: ${inputPath}`,
    });
  }
  return resolved;
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    // Missing, or below a regular file (ENOTDIR): no link either way.
    return false;
  }
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return !(
    rel === ".." ||
    rel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rel)
  );
}
