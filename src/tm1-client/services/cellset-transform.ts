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

  // totalCellCount: product of tuple counts across all axes, or cell count if no axes.
  const totalCellCount =
    axes.length > 0
      ? axes.reduce((acc, axis) => acc * axis.tuples.length, 1)
      : cells.length;

  return { cells, axes, totalCellCount };
}
