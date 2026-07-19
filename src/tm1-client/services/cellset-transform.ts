// Shared cellset → MdxResult mapper. Used by both CellService.executeMdx and
// ViewService.getView; lifted out of TM1Client so neither service has to depend
// on the other.
import type { CellValue, MdxAxis, MdxResult } from "../../types.js";
import type { RequestOptions, TM1HttpClient } from "../http.js";

// TM1 escaping: `]` inside a bracketed identifier is doubled. Cellset IDs are
// server-generated GUIDs so this is defensive, but keeps the pattern uniform.
function encId(id: string): string {
  return id.replace(/]/g, "]]");
}

// Best-effort DELETE of a read-path cellset. Cellsets are session-scoped and
// never auto-expire while keep-alive holds the session open, so a read that
// leaves one behind leaks TM1 server memory indefinitely (mirrors TM1py's
// delete_cellset). Never throws: cleanup failure must not turn a successful
// read into an error.
export async function freeCellset(
  http: TM1HttpClient,
  id: string | undefined,
  opts?: RequestOptions,
): Promise<void> {
  if (!id) return;
  try {
    await http.request<void>("DELETE", `/api/v1/Cellsets('${encId(id)}')`, undefined, opts);
  } catch {
    // cleanup best-effort
  }
}

interface RawCellsetResponse {
  Cells: Array<{ Value: CellValue; FormattedValue: string }>;
  Axes: Array<{
    Tuples: Array<{
      Members: Array<{
        Name: string;
        Hierarchy: { Name: string };
      }>;
    }>;
  }>;
}

// Clip each axis to just the tuples the returned cell window actually
// addresses, so a paginated read over a huge view doesn't ship the whole
// (e.g. 200k-row) tuple list alongside its capped cells.
//
// TM1 orders cells so axis 0 varies fastest: cell ordinal `ord` decomposes as
// idx_k = floor(ord / stride_k) mod L_k, stride_0 = 1, stride_k = product of
// lower axis lengths. The returned cells span the contiguous ordinal range
// [skip, skip+count). An axis is safe to shrink to `maxIdx+1` tuples ONLY when
// its quotient never wraps past its length within that range
// (qmax = floor(maxOrd/stride) < L) — that holds exactly for the slowest
// partially-referenced axis and every axis above it, never for a fully-cycled
// fast axis whose stride the higher axes decode through. Because those fast
// axes stay at full length, stride_k is preserved for every clipped axis and
// the consumer's positional decode (offset+i over the returned tuple counts)
// stays valid; axes above the pivot collapse to a single tuple (idx always 0,
// decoded via `mod 1`). totalCellCount is computed from the FULL axes, so the
// caller still sees the true cell total.
export function clipAxesToWindow(
  axes: MdxAxis[],
  cellCount: number,
  skip: number,
): { axes: MdxAxis[]; clipped: boolean } {
  if (axes.length === 0 || cellCount === 0) return { axes, clipped: false };
  const maxOrd = skip + cellCount - 1;
  let stride = 1;
  let clipped = false;
  const out = axes.map((axis) => {
    const len = axis.tuples.length;
    const qmax = len > 0 ? Math.floor(maxOrd / stride) : 0;
    stride *= len; // next axis's stride uses this axis's ORIGINAL length
    if (len > 0 && qmax < len) {
      const keep = qmax + 1;
      if (keep < len) {
        clipped = true;
        return { tuples: axis.tuples.slice(0, keep) };
      }
    }
    return axis;
  });
  return { axes: out, clipped };
}

export function transformCellsetResponse(response: RawCellsetResponse): MdxResult {
  const cells = (response.Cells ?? []).map((c) => ({
    value: c.Value,
    formattedValue: c.FormattedValue,
  }));

  const axes: MdxAxis[] = (response.Axes ?? []).map((axis) => ({
    tuples: axis.Tuples.map((tuple) => ({
      members: tuple.Members.map((m) => ({
        name: m.Name,
        hierarchyName: m.Hierarchy.Name,
      })),
    })),
  }));

  // totalCellCount: product of tuple counts across all axes, or cell count if
  // no axes. Always the FULL count; axis clipping (clipAxesToWindow) is applied
  // by the paginating tool layer, which keeps totalCellCount intact.
  const totalCellCount =
    axes.length > 0
      ? axes.reduce((acc, axis) => acc * axis.tuples.length, 1)
      : cells.length;

  return { cells, axes, totalCellCount };
}
