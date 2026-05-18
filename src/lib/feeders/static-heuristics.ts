/**
 * Static (rule-text only) overfeeding heuristics.
 *
 * Each detector takes already-parsed bracket lists (LHS of a single feeder or
 * rule line) and returns a boolean verdict. The tool layer composes these
 * into findings with severity = "hint" since no runtime evidence is observed.
 *
 * Heuristic IDs match docs/feeders-audit-spec.md:
 *   S1 — feeder_broader_than_rule
 *   S4 — wildcard_bracket
 *   S6 — orphan_feeder
 */
import type { BracketEntry, BracketList } from "./brackets.js";

/**
 * Pull every concrete element name out of a bracket list into a flat set.
 * Positional, qualified, and set-form entries all contribute their element
 * value(s). Dimension qualifiers are NOT bagged — only the element side.
 */
export function collectElementBag(list: BracketList): Set<string> {
  const out = new Set<string>();
  for (const e of list.entries) {
    pushElems(e, out);
  }
  return out;
}

function pushElems(e: BracketEntry, out: Set<string>): void {
  if (e.elem !== undefined) out.add(e.elem);
  if (e.elems !== undefined) {
    for (const v of e.elems) out.add(v);
  }
}

/**
 * S4 · Wildcard / unscoped bracket — bracket has no concrete element
 * constraints. Either an empty bracket or every entry lacks both `elem` and
 * `elems`. Such feeders fire across every dim member.
 */
export function detectWildcardBracket(list: BracketList): boolean {
  if (list.entries.length === 0) return true;
  return list.entries.every((e) => e.elem === undefined && e.elems === undefined);
}

/**
 * S1 · Feeder broader than rule — the feeder LHS pins fewer dims than the
 * **overlapping** rule LHS that it most plausibly serves. We approximate
 * "serves" via shared element names: a rule only counts as comparable when
 * its LHS shares at least one element with the feeder LHS, otherwise the
 * two are targeting different cell-spaces and a count comparison is noise.
 *
 * Without cube dim-order resolution (REST lookup, deferred to P2), this
 * remains a heuristic — an early live run on a v11 cube otherwise flagged
 * 91 % of feeders as broader-than-rule because every rule LHS in the cube
 * was a candidate baseline. Restricting to overlapping rules collapses that
 * to the cases that actually share semantic context.
 *
 * Returns false when no rules overlap (cube has feeders without matching
 * rules — orphan territory, flagged by S6 instead).
 */
export function detectBroaderThanRule(
  feeder: BracketList,
  ruleLhsList: ReadonlyArray<BracketList>,
): boolean {
  if (feeder.entries.length === 0) return false;
  if (ruleLhsList.length === 0) return false;
  const feederElems = collectElementBag(feeder);
  if (feederElems.size === 0) return false;

  let densestOverlapping = 0;
  for (const rule of ruleLhsList) {
    const ruleElems = collectElementBag(rule);
    let overlaps = false;
    for (const e of feederElems) {
      if (ruleElems.has(e)) {
        overlaps = true;
        break;
      }
    }
    if (overlaps && rule.entries.length > densestOverlapping) {
      densestOverlapping = rule.entries.length;
    }
  }
  if (densestOverlapping === 0) return false;
  return feeder.entries.length < densestOverlapping;
}

/**
 * S6 · Orphan feeder — the feeder LHS shares no element name with any rule
 * LHS in the cube. Pure overhead: it flags cells that no rule populates.
 * Element comparison is bag-equality on the element-side only (dim
 * qualifiers ignored), so positional and qualified syntax intermix.
 */
export function detectOrphanFeeder(
  feeder: BracketList,
  ruleLhsList: ReadonlyArray<BracketList>,
): boolean {
  if (feeder.entries.length === 0) return false;
  if (ruleLhsList.length === 0) return false;
  const feederElems = collectElementBag(feeder);
  if (feederElems.size === 0) return false;
  for (const rule of ruleLhsList) {
    const ruleElems = collectElementBag(rule);
    for (const e of feederElems) {
      if (ruleElems.has(e)) return false;
    }
  }
  return true;
}
