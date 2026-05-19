/**
 * Static (rule-text only) overfeeding heuristics.
 *
 * Each detector takes already-parsed bracket lists (LHS of a single feeder or
 * rule line) and returns a verdict. The tool layer composes these into
 * findings with severity = "hint" since no runtime evidence is observed.
 *
 * Heuristic IDs match docs/feeders-audit-spec.md:
 *   S1 — feeder_broader_than_rule       (needs cubeTotalDims)
 *   S2 — feeder_to_consolidated         (needs element-type cache)
 *   S4 — wildcard_bracket
 *   S6 — orphan_feeder
 */
import type { BracketEntry, BracketList } from "./brackets.js";
import type { ElementTypeCache } from "./element-type-cache.js";
import { extractDbCalls } from "../callgraph/rulesLinter.js";

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
 * S1 · Feeder broader than rule — feeder LHS pins a small fraction of the
 * cube's dimensions. Ratio-based to scale across cube widths: an absolute
 * "2 dims unpinned" threshold flooded findings on 13-dim cubes where
 * positional feeders idiomatically pin 7–8 dims (live test 2026-05-19:
 * 114/116 ≈ 98 % noise). The ratio gate restores precision because TM1
 * fills the unpinned dims with default members — only when the feeder
 * leaves most of the cube unconstrained is it genuinely too broad.
 *
 * Flags when `pinned / cubeTotalDims < minPinnedRatio` (default 0.5).
 *
 * Returns false on:
 *  - empty bracket (S4 territory)
 *  - missing cube dim count (resolver failure → cubeTotalDims ≤ 0)
 *  - feeder pinning more entries than cube has dims (malformed; skip)
 */
export function detectBroaderThanRule(
  feeder: BracketList,
  cubeTotalDims: number,
  minPinnedRatio = 0.5,
): boolean {
  if (feeder.entries.length === 0) return false;
  if (cubeTotalDims <= 0) return false;
  const pinned = feeder.entries.length;
  if (pinned > cubeTotalDims) return false;
  return pinned / cubeTotalDims < minPinnedRatio;
}

/**
 * S2 · Feeder targets consolidated element.
 *
 * For each entry in the feeder LHS, resolve `(dim, hier, elem)` and look up
 * the element type via the cache. Flag on the first consolidated element
 * encountered. Resolution rules:
 *  - positional entry at index `i` → `dim = hier = cubeDimNames[i]`
 *  - qualified entry `'Dim':'Elem'` → `dim = hier = Dim`
 *  - qualified entry `'Dim:Hier':'Elem'` → split on `:` (only for the dim slot)
 *  - set entries `'Dim':{'A','B'}` → check each element of the set
 *
 * Returns the matching `{dim, elem}` or `null`. The tool layer turns a
 * non-null result into a finding with severity `hint`.
 */
export async function detectFeederToConsolidated(
  feeder: BracketList,
  cubeDimNames: readonly string[],
  cache: ElementTypeCache,
): Promise<{ dim: string; elem: string } | null> {
  if (feeder.entries.length === 0) return null;
  if (cubeDimNames.length === 0) return null;

  for (let i = 0; i < feeder.entries.length; i++) {
    const e = feeder.entries[i]!;
    const resolved = resolveDimHier(e, i, cubeDimNames);
    if (!resolved) continue;
    const elems = entryElems(e);
    for (const elem of elems) {
      const t = await cache.getType(resolved.dim, resolved.hier, elem);
      if (t === "Consolidated") {
        return { dim: resolved.dim, elem };
      }
    }
  }
  return null;
}

function resolveDimHier(
  e: BracketEntry,
  positionalIndex: number,
  cubeDimNames: readonly string[],
): { dim: string; hier: string } | null {
  if (e.dim !== undefined) {
    const colonIdx = e.dim.indexOf(":");
    if (colonIdx >= 0) {
      return {
        dim: e.dim.slice(0, colonIdx),
        hier: e.dim.slice(colonIdx + 1),
      };
    }
    return { dim: e.dim, hier: e.dim };
  }
  const name = cubeDimNames[positionalIndex];
  if (name === undefined) return null;
  return { dim: name, hier: name };
}

function entryElems(e: BracketEntry): string[] {
  if (e.elem !== undefined) return [e.elem];
  if (e.elems !== undefined) return e.elems;
  return [];
}

/**
 * S5 · `DB()` feeder without skipcheck on target. Cross-cube feeders fan out
 * through the target cube's consolidations; without `skipcheck;` on the
 * target's rules the engine evaluates every cell. Walk every `DB(...)` call
 * on the feeder line, ask the lookup whether the target cube has skipcheck.
 *
 * Returns the first target-cube name that lacks skipcheck, or `null` on:
 *  - no `DB()` call on the line
 *  - dynamic cube name (not a string literal — can't resolve statically)
 *  - lookup returns `null` (target outside scan scope — be conservative)
 *  - lookup returns `true` (skipcheck present)
 */
export function detectDbFeederWithoutSkipcheck(
  line: string,
  hasSkipcheck: (cubeName: string) => boolean | null,
): string | null {
  const calls = extractDbCalls(line);
  for (const call of calls) {
    if (call.cubeName === null) continue;
    const verdict = hasSkipcheck(call.cubeName);
    if (verdict === false) return call.cubeName;
  }
  return null;
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
