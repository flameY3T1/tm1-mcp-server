// Resolve a caller's named-dimension cell address against the cube's real
// dimension list, before anything is written.
//
// Why: the write path builds an MDX tuple over the dimensions the caller
// names, and TM1 fills every dimension left out with its default member —
// without an error. A write that leaves out the measure dimension lands on
// its default element and overwrites the value there.
//
// The one dimension that may be left out is the `Sandboxes` dimension that
// `EnableSandboxDimension=true` adds to every cube: callers rarely think of it
// as part of the cube. It is bound to `Base` explicitly rather than left to
// TM1's default member, because the default is only `Base` while `Base` is
// the dimension's sole member. A cube with a regular dimension that happens to
// be named Sandboxes but has no `Base` fails loudly with TM1's "member not
// found", never silently.
//
// Ported from the ffschrattenecker/tm1-mcp-server fork (d2ad818).
import { TM1Error, TM1ErrorCode } from "../types.js";

export const SANDBOX_DIMENSION = "Sandboxes";
export const BASE_SANDBOX = "Base";

/** Index of the cube's `Sandboxes` dimension, or -1. */
export function sandboxPosition(cubeDimensions: readonly string[]): number {
  return cubeDimensions.findIndex(
    (d) => d.toLowerCase() === SANDBOX_DIMENSION.toLowerCase(),
  );
}

/**
 * Positional counterpart of resolveCellAddress, for tools that take one
 * element per cube dimension (get_cell_value, check_writable_coords without
 * `dimensions`). A coordinate exactly one short on a cube with `Sandboxes`
 * is read as "Sandboxes left out" and gets `Base` at its position — or
 * `fill`, when the caller addresses a named sandbox; anything else returns
 * undefined and the caller's count check refuses it as before.
 */
export function bindLeftOutSandbox(
  cubeDimensions: readonly string[],
  elements: readonly string[],
  fill: string = BASE_SANDBOX,
): string[] | undefined {
  if (elements.length !== cubeDimensions.length - 1) return undefined;
  const pos = sandboxPosition(cubeDimensions);
  if (pos < 0) return undefined;
  return [...elements.slice(0, pos), fill, ...elements.slice(pos)];
}

export interface ResolvedAddress {
  /** The cube's dimensions, in cube order. */
  dimensions: string[];
  /** Maps a caller's elements (in the caller's dimension order) to cube order. */
  toCubeOrder: (elements: readonly string[]) => string[];
  /** Set when `Sandboxes` was left out and bound to `Base`. */
  sandboxDefaulted?: typeof BASE_SANDBOX;
}

export function resolveCellAddress(
  cubeName: string,
  cubeDimensions: readonly string[],
  given: readonly string[],
  outcome = "Nothing was written.",
): ResolvedAddress {
  const byLower = new Map(cubeDimensions.map((d, i) => [d.toLowerCase(), i]));
  const positions: number[] = [];
  const unknown: string[] = [];
  const duplicate: string[] = [];
  const seen = new Set<number>();
  for (const name of given) {
    const pos = byLower.get(name.toLowerCase());
    if (pos === undefined) unknown.push(name);
    else if (seen.has(pos)) duplicate.push(name);
    else seen.add(pos);
    positions.push(pos ?? -1);
  }
  const sandboxPos = sandboxPosition(cubeDimensions);
  const missing = cubeDimensions.filter((_, i) => !seen.has(i));
  const onlySandboxMissing =
    missing.length === 1 && sandboxPos >= 0 && !seen.has(sandboxPos);

  const problems: string[] = [];
  if (unknown.length > 0)
    problems.push(`not in the cube: ${unknown.join(", ")}`);
  if (duplicate.length > 0)
    problems.push(`listed twice: ${duplicate.join(", ")}`);
  if (missing.length > 0 && !onlySandboxMissing)
    problems.push(`missing: ${missing.join(", ")}`);
  if (problems.length > 0) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: `Dimensions do not match cube '${cubeName}' — ${problems.join("; ")}. ${outcome}`,
      hint: `Name every dimension of the cube (any order): ${cubeDimensions.join(", ")}. A dimension left out is not ignored — TM1 writes into its default member.${sandboxPos >= 0 ? ` Only ${SANDBOX_DIMENSION} may be left out; it is then bound to ${BASE_SANDBOX}.` : ""}`,
    });
  }

  return {
    dimensions: [...cubeDimensions],
    toCubeOrder: (elements) => {
      const out = new Array<string>(cubeDimensions.length);
      elements.forEach((e, i) => {
        out[positions[i]!] = e;
      });
      if (onlySandboxMissing) out[sandboxPos] = BASE_SANDBOX;
      return out;
    },
    ...(onlySandboxMissing ? { sandboxDefaulted: BASE_SANDBOX } : {}),
  };
}
