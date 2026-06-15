import safeRegex from "safe-regex";
import { TM1Error, TM1ErrorCode } from "../types.js";

/**
 * Compile a user-supplied regex behind a ReDoS guard.
 *
 * Every `new RegExp(<user/LLM input>)` site must route through this helper:
 * `safe-regex` rejects catastrophic-backtracking patterns (e.g. `(a+)+$`) before
 * the pattern is ever constructed, so a malicious caller cannot freeze the Node
 * event loop and DoS the server. Invalid patterns are normalized to a
 * VALIDATION_ERROR instead of surfacing as a raw SyntaxError.
 *
 * @param pattern user-supplied regex source
 * @param flags   optional RegExp flags (e.g. "i", "gi")
 * @param label   human label for error messages (e.g. "nameRegex"); defaults to "regex"
 */
export function compileUserRegex(pattern: string, flags?: string, label = "regex"): RegExp {
  if (!safeRegex(pattern)) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: `${label} rejected: pattern risks catastrophic backtracking (ReDoS).`,
      details: pattern,
      hint: "Avoid nested unbounded quantifiers like (a+)+ or (.*)* — simplify or anchor the pattern.",
    });
  }
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: `Invalid ${label}: ${(e as Error).message}`,
      details: pattern,
      hint: "Pattern must be a valid JavaScript regex. Escape backslashes and balance brackets/parens.",
    });
  }
}
