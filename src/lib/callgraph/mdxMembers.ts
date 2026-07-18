// Pure MDX member extractor: pulls literally-named [Dim].[...].[El] member
// references out of an MDX string, and separately flags MDX set functions
// that scope elements WITHOUT naming them (e.g. all leaves under a
// dimension) so callers can report them as unresolved rather than imply
// "no elements".

export interface MdxMemberRef {
  dimension: string;
  element: string;
}

export interface MdxExtractResult {
  members: MdxMemberRef[];
  computedSelectors: string[];
}

/** MDX set functions that compute membership without naming elements (Bucket C boundary). */
export const MDX_COMPUTED_FUNCS: ReadonlySet<string> = new Set([
  "TM1FILTERBYLEVEL",
  "TM1FILTERBYPATTERN",
  "TM1SUBSETALL",
  "TM1DRILLDOWNMEMBER",
  "DESCENDANTS",
  "ANCESTORS",
  "ANCESTOR",
  "CHILDREN",
  "MEMBERS",
  "HIERARCHIZE",
  "FILTER",
  "TOPCOUNT",
  "BOTTOMCOUNT",
  "ORDER",
  "EXCEPT",
  "GENERATE",
]);

// One bracketed segment: [ ... ] where ]] is an escaped ]. A chain of >=2
// segments separated by dots is a member path; a lone segment is a
// dimension/hierarchy ref.
const MEMBER_PATH_RE = /(\[(?:[^\]]|\]\])*\])(?:\s*\.\s*(\[(?:[^\]]|\]\])*\]))+/g;
const SEGMENT_RE = /\[((?:[^\]]|\]\])*)\]/g;
const FUNC_RE = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

function unbracket(seg: string): string {
  // strip outer [ ], unescape ]] -> ]
  return seg.slice(1, -1).replace(/\]\]/g, "]");
}

export function extractMdxMemberRefs(mdx: string): MdxExtractResult {
  const members: MdxMemberRef[] = [];
  const seen = new Set<string>();

  let m: RegExpExecArray | null;
  MEMBER_PATH_RE.lastIndex = 0;
  while ((m = MEMBER_PATH_RE.exec(mdx)) !== null) {
    const chain = m[0];
    SEGMENT_RE.lastIndex = 0;
    const segs: string[] = [];
    let s: RegExpExecArray | null;
    while ((s = SEGMENT_RE.exec(chain)) !== null) {
      segs.push(unbracket(s[0]));
    }
    if (segs.length < 2) continue;
    // segs.length >= 2 is guaranteed by the check above, so both indices exist.
    const dimension = segs[0]!;
    const element = segs[segs.length - 1]!;
    const key = `${dimension.toLowerCase()} ${element.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      members.push({ dimension, element });
    }
  }

  const computedSelectors: string[] = [];
  const seenFuncs = new Set<string>();
  FUNC_RE.lastIndex = 0;
  let f: RegExpExecArray | null;
  while ((f = FUNC_RE.exec(mdx)) !== null) {
    // f[1] is always present: FUNC_RE's single capture group is not optional.
    const name = f[1]!.toUpperCase();
    if (MDX_COMPUTED_FUNCS.has(name) && !seenFuncs.has(name)) {
      seenFuncs.add(name);
      computedSelectors.push(name);
    }
  }

  return { members, computedSelectors: [...computedSelectors].sort((a, b) => a.localeCompare(b)) };
}
