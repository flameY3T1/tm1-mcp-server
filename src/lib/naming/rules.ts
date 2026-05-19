/**
 * TM1 / Planning Analytics object naming rules.
 *
 * Sources:
 *  - IBM PA 2.0: https://www.ibm.com/docs/en/planning-analytics/2.0.0?topic=development-tm1-object-naming-conventions
 *  - IBM PA 3.1: https://www.ibm.com/docs/en/planning-analytics/3.1.0?topic=references-naming-conventions
 *
 * Pass/fail semantics: every rule in this file is a HARD violation. Soft
 * "avoid" recommendations from the IBM docs are intentionally not modelled.
 */

export type ObjectKind =
  | "cube"
  | "dimension"
  | "hierarchy"
  | "subset"
  | "view"
  | "process"
  | "chore"
  | "element"
  | "attribute"
  | "processVariable";

export type TM1MajorVersion = 11 | 12;

export interface Violation {
  rule: string;
  message: string;
  /** Offending character (literal) when the rule is character-based. */
  char?: string;
  /** Zero-based position of the offending character. */
  position?: number;
}

/**
 * Characters explicitly reserved by the TM1 Server for Cube, Dimension,
 * Subset, View, Process, and Chore names. Source: IBM PA naming docs,
 * "Reserved characters per component" → "TM1 Server reserves these characters".
 */
const SERVER_RESERVED_CHARS = new Set([
  "\\",
  "/",
  ":",
  "*",
  "?",
  '"',
  "<",
  ">",
  "|",
  "'",
  ";",
  ",",
]);

/**
 * Allowed pattern for TI process variable identifiers (must start with letter).
 * Backtick is included because TI tolerates it in data-source column references
 * (e.g., `\`col_name\``-style identifiers exported from SQL/ODBC sources).
 */
const PROCESS_VAR_ALLOWED = /^[A-Za-z][A-Za-z0-9.$%_`]*$/;

/** Conservative TM1 name length cap (cube/dim/process historically 256). */
const MAX_NAME_LENGTH = 256;

const SERVER_RESERVED_KINDS: ReadonlySet<ObjectKind> = new Set([
  "cube",
  "dimension",
  "hierarchy",
  "subset",
  "view",
  "process",
  "chore",
]);

function checkServerReservedChars(name: string): Violation | null {
  for (let i = 0; i < name.length; i++) {
    const ch = name[i]!;
    if (SERVER_RESERVED_CHARS.has(ch)) {
      return {
        rule: "server_reserved_char",
        message: `Contains TM1-Server-reserved character '${ch}' at position ${i}. Reserved set: \\ / : * ? " < > | ' ; ,`,
        char: ch,
        position: i,
      };
    }
  }
  return null;
}

function checkLeadingControlPrefix(name: string): Violation | null {
  if (name.startsWith("}")) {
    return {
      rule: "leading_control_prefix",
      message:
        "Starts with '}' — reserved prefix for TM1 control objects. User objects with this prefix are hidden when Display Control Objects is off.",
      char: "}",
      position: 0,
    };
  }
  return null;
}

function checkEmpty(name: string): Violation | null {
  if (name.length === 0 || name.trim().length === 0) {
    return {
      rule: "empty",
      message: "Name is empty or whitespace-only.",
    };
  }
  return null;
}

function checkLength(name: string): Violation | null {
  if (name.length > MAX_NAME_LENGTH) {
    return {
      rule: "length_exceeds",
      message: `Name length ${name.length} exceeds the conservative TM1 cap of ${MAX_NAME_LENGTH} characters.`,
    };
  }
  return null;
}

function checkLeadingTrailingWhitespace(name: string): Violation | null {
  if (name.length === 0) return null;
  if (name !== name.trim()) {
    return {
      rule: "leading_trailing_whitespace",
      message: "Has leading or trailing whitespace.",
    };
  }
  return null;
}

function checkElementLeadingArithmetic(name: string): Violation | null {
  const first = name[0];
  if (first === "+" || first === "-") {
    return {
      rule: "element_leading_arithmetic",
      message: `Element name starts with '${first}' — breaks MDX active-form sets and rule references.`,
      char: first,
      position: 0,
    };
  }
  return null;
}

function checkElementContainsTab(
  name: string,
  version: TM1MajorVersion,
): Violation | null {
  if (version !== 12) return null;
  const idx = name.indexOf("\t");
  if (idx >= 0) {
    return {
      rule: "element_contains_tab",
      message:
        "Element name contains TAB. Reserved by Planning Analytics 3.1 as the name/alias separator.",
      char: "\t",
      position: idx,
    };
  }
  return null;
}

function checkProcessVariable(name: string): Violation | null {
  if (name.length === 0) {
    return { rule: "empty", message: "Process variable name is empty." };
  }
  if (PROCESS_VAR_ALLOWED.test(name)) return null;

  const first = name[0]!;
  if (!/[A-Za-z]/.test(first)) {
    return {
      rule: "process_var_leading_non_letter",
      message: `Process variable '${name}' must start with a letter (got '${first}').`,
      char: first,
      position: 0,
    };
  }
  for (let i = 0; i < name.length; i++) {
    const ch = name[i]!;
    if (!/[A-Za-z0-9.$%_`]/.test(ch)) {
      return {
        rule: "process_var_invalid_char",
        message: `Process variable contains disallowed character '${ch}' at position ${i}. Allowed: letters, digits, . $ % _ \``,
        char: ch,
        position: i,
      };
    }
  }
  return null;
}

/**
 * Validate a single TM1 object name. Returns all hard violations.
 * Order: empty → length → whitespace → reserved-char → control-prefix → element-specific.
 */
export function checkName(
  name: string,
  kind: ObjectKind,
  version: TM1MajorVersion = 11,
): Violation[] {
  if (kind === "processVariable") {
    const v = checkProcessVariable(name);
    return v ? [v] : [];
  }

  const violations: Violation[] = [];

  const empty = checkEmpty(name);
  if (empty) {
    violations.push(empty);
    return violations;
  }

  // Elements/attributes have no IBM-defined hard length limit; the 256-char
  // cap is only documented for cube/dim/view/subset/process/chore names.
  // TM1 v11 servers accept element names well beyond 256 chars via REST.
  if (kind !== "element" && kind !== "attribute") {
    const length = checkLength(name);
    if (length) violations.push(length);
  }

  const whitespace = checkLeadingTrailingWhitespace(name);
  if (whitespace) violations.push(whitespace);

  if (SERVER_RESERVED_KINDS.has(kind) || kind === "element" || kind === "attribute") {
    const reserved = checkServerReservedChars(name);
    if (reserved) violations.push(reserved);
  }

  const controlPrefix = checkLeadingControlPrefix(name);
  if (controlPrefix) violations.push(controlPrefix);

  if (kind === "element" || kind === "attribute") {
    const arithmetic = checkElementLeadingArithmetic(name);
    if (arithmetic) violations.push(arithmetic);

    const tab = checkElementContainsTab(name, version);
    if (tab) violations.push(tab);
  }

  return violations;
}

/** Parse "11.8.x" / "12.0.x" → 11 or 12. Falls back to 11. */
export function parseMajorVersion(productVersion: string): TM1MajorVersion {
  const match = productVersion.match(/^(\d+)/);
  if (!match) return 11;
  const major = Number(match[1]);
  return major >= 12 ? 12 : 11;
}
