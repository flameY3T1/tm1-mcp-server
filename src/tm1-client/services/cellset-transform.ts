// Shared cellset → MdxResult mapper. Used by both CellService.executeMdx and
// ViewService.getView; lifted out of TM1Client so neither service has to depend
// on the other.
import type { CellValue, MdxAxis, MdxResult } from "../../types.js";

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
