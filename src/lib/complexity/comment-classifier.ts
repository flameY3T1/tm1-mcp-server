/**
 * Heuristic split of `#`-comment lines into real comments (natural-language
 * documentation) vs commented-out code (disabled TM1 rule/TI statements).
 *
 * In TM1 the `#` prefix serves both roles, so a naive "starts with #" comment
 * count conflates the two. That matters because the complexity scorer can
 * *discount* a score by its comment ratio (commentDiscountMax): disabled dead
 * code masquerading as documentation would make a complex object look simpler,
 * and inflate "well-documented" signals. This classifier lets callers count the
 * two separately.
 *
 * The heuristic favours low false positives on prose: the dominant signal is a
 * trailing `;` (almost every active TM1 statement ends with one; prose rarely
 * does), backed by structural signals (rule-area assignment, variable
 * assignment, known function calls, control-flow keywords with a paren, bare
 * directives). It is intentionally fuzzy — there is no parser that can tell a
 * disabled statement from prose with certainty.
 */

const CODE_SIGNALS: ReadonlyArray<RegExp> = [
  // Statement terminator at end of line — the strongest TM1 signal.
  /;\s*$/,
  // Rule-area assignment: `['Sales'] = ...`
  /^\[[^\]]*\]\s*=/,
  // Variable / cube-cell assignment: `vX = ...` or `nResult=...` (not `==`).
  /^[A-Za-z_]\w*\s*=(?!=)/,
  // Known TM1 function call: `Name(` (case-insensitive — TM1 is).
  /\b(?:CellPutN|CellPutS|CellGetN|CellGetS|CellIsUpdateable|DB|DBRW|DBRA|DBSW|DBSS|AttrPutN|AttrPutS|AttrN|AttrS|ElementName|ElementIndex|DimensionElementInsert|DimensionElementComponentAdd|HierarchyElementInsert|ExecuteProcess|ExecuteCommand|RunProcess|ProcessQuit|ProcessBreak|ItemSkip|ItemReject|ViewZeroOut|CubeClearData|CubeSetLogChanges|ASCIIOutput|TextOutput|SubsetCreate|NumberToString|StringToNumber)\s*\(/i,
  // Control-flow keyword immediately followed by a paren: `IF(`, `WHILE (`.
  /^(?:IF|WHILE|ELSEIF)\s*\(/i,
  // Bare block directives / keywords on their own line.
  /^(?:SKIPCHECK|FEEDERS|FEEDSTRINGS|ENDIF|ELSE|END|PROCESSBREAK|PROCESSQUIT|ITEMSKIP)\s*;?\s*$/i,
];

/**
 * True when a `#`-prefixed comment line looks like disabled TM1 code rather
 * than prose. Accepts the trimmed line with or without its leading `#`.
 */
export function isCommentedOutCode(commentLine: string): boolean {
  const body = commentLine.replace(/^#+/, "").trim();
  if (body === "") return false;
  return CODE_SIGNALS.some((re) => re.test(body));
}
