// Server-side prefilter for the element naming audit.
//
// Auditing element names used to mean downloading them all: 15.2 MB for a
// single 171k-element dimension, 66 MB across a real model, and — worse — a
// cap (`maxElementsPerDim`) beyond which the audit silently checked only a
// prefix of the dimension.
//
// Every element rule in ./rules.ts is character-based, and TM1 implements the
// OData string functions those rules need (`startswith`, `endswith`,
// `contains`, `indexof`, `trim`, `length` — all verified live against 11.8).
// So the server can do the narrowing: ask it for the names that MIGHT violate
// a rule, and check only those.
//
// The contract this file must honour is SOUNDNESS, not exactness:
//
//   checkName(name) is non-empty  ⟹  the filter matches name
//
// A filter that also matches innocent names costs a few extra rows and nothing
// else, because `checkName` still decides. A filter that misses a violator
// turns the audit into a lie. `matchesElementViolationFilter` mirrors the
// emitted expression in TypeScript so the property can be tested directly;
// tests/unit/naming-odata-filter.test.ts asserts it over every rule class,
// and the live suite asserts that TM1 agrees.
import { SERVER_RESERVED_CHARS, type TM1MajorVersion } from "./rules.js";

/** OData string literal: single quotes double. */
function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * `$filter` expression selecting elements that may violate a naming rule.
 *
 * Mirrors the element branch of `checkName`: empty/whitespace-only, leading or
 * trailing whitespace, TM1-Server-reserved characters, the `}` control prefix,
 * a leading `+`/`-`, and — on v12 only — an embedded TAB.
 */
export function elementViolationFilter(version: TM1MajorVersion): string {
  const clauses = [
    // checkEmpty: name.trim() is empty. Covers "" and whitespace-only in one.
    "length(trim(Name)) eq 0",
    // checkLeadingTrailingWhitespace: name !== name.trim(). Expressed with
    // trim() rather than a list of space characters, so every whitespace
    // codepoint is covered instead of the handful someone remembered.
    "trim(Name) ne Name",
    // checkLeadingControlPrefix
    `startswith(Name,${lit("}")})`,
    // checkElementLeadingArithmetic
    `startswith(Name,${lit("+")})`,
    `startswith(Name,${lit("-")})`,
    // checkServerReservedChars — elements are in scope for these too.
    ...[...SERVER_RESERVED_CHARS].map((ch) => `contains(Name,${lit(ch)})`),
  ];

  // checkElementContainsTab is v12-only. TAB cannot appear raw in a URL, so it
  // goes in percent-encoded; the surrounding query is not re-encoded.
  if (version === 12) clauses.push("indexof(Name,'%09') ge 0");

  return clauses.join(" or ");
}

/**
 * The same predicate in TypeScript, for testing soundness against `checkName`
 * without a server. Kept beside the builder so the two cannot drift: a rule
 * added to one and forgotten in the other fails the unit test.
 */
export function matchesElementViolationFilter(
  name: string,
  version: TM1MajorVersion,
): boolean {
  if (name.trim().length === 0) return true;
  if (name !== name.trim()) return true;
  if (name.startsWith("}")) return true;
  if (name.startsWith("+") || name.startsWith("-")) return true;
  for (const ch of SERVER_RESERVED_CHARS) if (name.includes(ch)) return true;
  if (version === 12 && name.includes("\t")) return true;
  return false;
}
