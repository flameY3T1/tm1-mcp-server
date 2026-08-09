/**
 * Shared `}StatsByCube` fetcher.
 *
 * Reads one cube's perf metrics into a flat `{ measureName: value }` map
 * plus a typed projection over well-known measures. Used by both
 * `tm1_get_cube_stats` (read-tool) and `tm1_audit_feeders` (runtime mode).
 *
 * The MDX targets `}StatsByCube` (TM1 v11.8 layout verified live):
 *   cube dim    → `}PerfCubes`
 *   measure dim → `}StatsStatsByCube`
 *   time dim    → `}TimeIntervals` sliced on `LATEST` for the current snapshot
 * `TM1FILTERBYLEVEL` keeps only leaf measures.
 *
 * Not every server has those cubes. TM1 v12 / Planning Analytics Engine
 * (measured on 12.5.9) ships control cubes for security and element
 * attributes only — zero `}Stats*` — and a v11 non-admin can be refused read
 * access to them. Both surfaced as raw OData text, which reads like the
 * user's model is broken. `fetchCubeStats` classifies those two cases into a
 * `CubeStatsUnavailableError` here, once, so every caller degrades the same
 * way instead of re-deriving it at the tool layer.
 *
 * The classification is STRUCTURAL — it never reads the error sentence.
 * Measured, same question asked three ways:
 *   v11 11.8 (en) : '}StatsByCube' can not be found in collection of type 'Cube'
 *   v12 12.5.9    : There is no cube named "}StatsByCube".
 *   v11 11.8 (de) : Syntaxfehler bei oder in der Nähe von: '[…]', Zeichenposition 67
 * The prose varies by version AND by server locale, so a matcher built on it
 * is correct only on the machine it was written against and fails silently
 * everywhere else — in the direction of showing the user a raw OData error.
 * Instead: the denial is recognised by its untranslated identifier
 * (`ObjectSecurityNoReadRights`, an error code), and absence is answered by
 * asking the server directly whether the cube exists.
 */
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";

/** Server-side `}StatsByCube` measure labels mapped to stable typed fields. */
export const KNOWN_METRICS: Record<string, string> = {
  "Memory Used for Views": "memoryViews",
  "Memory Used for Input Data": "memoryInput",
  "Memory Used for Feeders": "memoryFeeders",
  "Memory Used for Calculations": "memoryCalculations",
  "Total Memory Used": "memoryTotal",
  "Number of Populated Numeric Cells": "populatedNumeric",
  "Number of Populated String Cells": "populatedString",
  "Number of Stored Calculated Cells": "storedCalculated",
  "Number of Stored Views": "storedViews",
  "Number of Fed Cells": "fedCells",
  "Steps of Average Calculation": "avgCalculationSteps",
  "Rule calculation cache miss rate": "cacheMissRate",
};

export interface CubeStatsItem {
  cubeName: string;
  raw: Record<string, number | null>;
  error?: string;
  feederEfficiency?: number;
  [k: string]: unknown;
}

/**
 * Why cube statistics could not be read — a distinction worth keeping honest:
 *
 * - `absent` — this server has no `}StatsByCube`. Nothing the caller can do;
 *   no account has these numbers here.
 * - `denied` — the cube exists, this TM1 user may not read it. A different
 *   person, or the same person with control-object read rights, would get
 *   the statistics. Telling them "your server does not have this" would be
 *   a lie.
 */
export type StatsUnavailableReason = "absent" | "denied";

/**
 * Thrown by `fetchCubeStats` when `}StatsByCube` cannot be read for a reason
 * that is a property of the *server or the account*, not of the cube being
 * asked about. Callers should surface `message` verbatim and branch on
 * `reason`; anything else that fails still propagates unchanged.
 */
export class CubeStatsUnavailableError extends Error {
  readonly reason: StatsUnavailableReason;

  constructor(reason: StatsUnavailableReason, message: string) {
    super(message);
    this.name = "CubeStatsUnavailableError";
    this.reason = reason;
  }
}

/** The cube the MDX reads. Probed by name when the query fails. */
export const STATS_CUBE = "}StatsByCube";

/**
 * The one string this module compares against, and it is not prose: TM1's
 * object-level denial identifier. It is an error code — it appears verbatim
 * in the payload on a German or Japanese server exactly as it does on an
 * English one, which is precisely why it is safe to match and a sentence
 * is not.
 */
const DENIAL_IDENTIFIER = "ObjectSecurityNoReadRights";

/**
 * Connection-scoped capability verdict, same idea as `BatchService.supported`:
 * once the server has answered whether `}StatsByCube` exists, that is fixed
 * for the connection, so an audit over 200 cubes neither fires 200 doomed MDX
 * queries nor 200 existence probes. A denial is deliberately NOT cached — an
 * administrator can grant rights mid-session, so it is re-probed every time.
 */
const statsCubeVerdict = new WeakMap<
  object,
  "present" | CubeStatsUnavailableError
>();

function isDenial(err: unknown): boolean {
  if (err instanceof TM1Error) {
    if (err.code === TM1ErrorCode.PERMISSION_DENIED) return true;
    if ((err.details ?? "").includes(DENIAL_IDENTIFIER)) return true;
  }
  // Non-TM1Error wrappers: the identifier still travels in the text.
  return err instanceof Error && err.message.includes(DENIAL_IDENTIFIER);
}

function deniedError(): CubeStatsUnavailableError {
  return new CubeStatsUnavailableError(
    "denied",
    `Reading the ${STATS_CUBE} control cube was refused for the current TM1 user ` +
      `(${DENIAL_IDENTIFIER}), so cube statistics are unavailable. The statistics cubes ` +
      `are present on this server — this is a rights issue, not a missing feature. ` +
      `Control-object read access is normally admin-only; ask an administrator for read ` +
      `rights on ${STATS_CUBE}, or run this with an admin account.`,
  );
}

function absentError(version?: 11 | 12): CubeStatsUnavailableError {
  const versionNote =
    version === 12
      ? "This server reports TM1 v12, which is the known case: Planning Analytics Engine " +
        "ships no }Stats* performance control cubes (verified on 12.5.9)."
      : "Known case: TM1 v12 / Planning Analytics Engine ships no }Stats* performance " +
        "control cubes (verified on 12.5.9); TM1 v11 exposes them.";
  return new CubeStatsUnavailableError(
    "absent",
    `The ${STATS_CUBE} control cube does not exist on this server, so cube statistics ` +
      `cannot be read. ${versionNote} Nothing is wrong with your model, and no account ` +
      `can read these numbers here — use rule/feeder static analysis instead.`,
  );
}

/**
 * Map a `}StatsByCube` MDX failure onto an unavailability verdict, or `null`
 * when the failure is about something else (a nonexistent target cube, a
 * syntax error, a timeout, a 500) and must propagate untouched.
 *
 * Structural, in two steps, neither of which reads a sentence:
 *
 *  1. Denial by identifier. TM1 refuses a control-object read with HTTP 400
 *     carrying `ObjectSecurityNoReadRights` (not 403), which `classifyHttpError`
 *     already turns into `PERMISSION_DENIED`. Checked first, because "you may
 *     not read it" must never be reported as "this server does not have it".
 *  2. Existence, asked of the server: `GET /api/v1/Cubes('}StatsByCube')`.
 *     404 → the cube is genuinely not there → `absent`. 200 → the cube is
 *     there and the MDX failed for some other reason entirely → `null`, and
 *     the original error propagates. One cheap request, only on the failure
 *     path, answering the actual question instead of inferring it.
 *
 * The probe's own failure never masks the real error: if the probe cannot
 * answer, the original error wins.
 *
 * `version` feeds the wording only; nothing branches on it.
 */
export async function classifyCubeStatsFailure(
  tm1Client: TM1Client,
  err: unknown,
): Promise<CubeStatsUnavailableError | null> {
  if (isDenial(err)) return deniedError();

  const cached = statsCubeVerdict.get(tm1Client);
  if (cached) return cached === "present" ? null : cached;

  let present: boolean;
  try {
    present = await tm1Client.cubes.exists(STATS_CUBE);
  } catch (probeErr) {
    // Probing is itself a control-object read, so it can be refused where the
    // MDX was refused for a different reason. Any other probe failure means
    // we simply do not know — say nothing and let the original error stand.
    return isDenial(probeErr) ? deniedError() : null;
  }

  if (present) {
    statsCubeVerdict.set(tm1Client, "present");
    return null;
  }
  const verdict = absentError(tm1Client.version);
  statsCubeVerdict.set(tm1Client, verdict);
  return verdict;
}

export async function fetchCubeStats(
  tm1Client: TM1Client,
  cubeName: string,
): Promise<CubeStatsItem> {
  const known = statsCubeVerdict.get(tm1Client);
  if (known && known !== "present") throw known;

  const safe = cubeName.replace(/]/g, "]]");
  const mdx = [
    "SELECT",
    `  {[}PerfCubes].[}PerfCubes].[${safe}]} ON 0,`,
    "  {TM1FILTERBYLEVEL({TM1SUBSETALL([}StatsStatsByCube].[}StatsStatsByCube])}, 0)} ON 1",
    "FROM [}StatsByCube]",
    "WHERE ([}TimeIntervals].[LATEST])",
  ].join("\n");

  let result;
  try {
    result = await tm1Client.cells.executeMdx(mdx);
  } catch (err) {
    const unavailable = await classifyCubeStatsFailure(tm1Client, err);
    if (!unavailable) throw err;
    throw unavailable;
  }

  const raw: Record<string, number | null> = {};
  const tuples = result.axes[1]?.tuples ?? [];
  for (let i = 0; i < tuples.length; i++) {
    const memberName = tuples[i]!.members[0]?.name ?? `unknown_${i}`;
    const cell = result.cells[i];
    raw[memberName] = typeof cell?.value === "number" ? cell.value : null;
  }

  const item: CubeStatsItem = { cubeName, raw };
  for (const [src, target] of Object.entries(KNOWN_METRICS)) {
    const v = raw[src];
    if (typeof v === "number") item[target] = v;
  }

  // Derived metric: feederEfficiency = fedCells / populatedNumeric.
  const fed = item.fedCells;
  const populated = item.populatedNumeric;
  if (
    typeof fed === "number" &&
    typeof populated === "number" &&
    populated > 0
  ) {
    item.feederEfficiency = Number((fed / populated).toFixed(3));
  }

  return item;
}

/**
 * Fed-to-populated ratio: `fedCells / populatedNumeric` — the community-
 * standard }StatsByCube overfeeding indicator (tm1forum t=13110, Cubewise).
 * Rule of thumb: ≥ 50× suspicious, ≥ 100× definite overfeeding. Returns
 * `null` when either input is missing or `populatedNumeric` is zero — a
 * cube fed purely cross-cube can legitimately hold no input data, so a
 * missing denominator is "insufficient signal", not overfeeding.
 */
export function computeFedToPopulatedRatio(
  stats: CubeStatsItem,
): number | null {
  const pop = stats.populatedNumeric;
  const fed = stats.fedCells;
  if (typeof pop !== "number" || typeof fed !== "number" || pop <= 0)
    return null;
  return fed / pop;
}

/**
 * Feeder-memory ratio: `memoryFeeders / memoryInput` — secondary overfeeding
 * signal (feeder flags dwarfing the data they feed from). No community
 * threshold established; reported as context only, never flagged.
 */
export function computeFeederMemoryRatio(stats: CubeStatsItem): number | null {
  const feeders = stats.memoryFeeders;
  const input = stats.memoryInput;
  if (typeof feeders !== "number" || typeof input !== "number" || input <= 0)
    return null;
  return feeders / input;
}
