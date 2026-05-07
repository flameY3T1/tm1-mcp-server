// Pure helpers for tm1_sample_cells: MDX construction and cellset transformation.
// No I/O — kept pure for unit-testability.

import type { MdxResult, CellValue } from "../types.js";

export type SampleCellFilter = string | string[];

export interface SampleCellsBuildArgs {
  cubeName: string;
  /** Cube dimension names in declaration order (used for crossjoin layout). */
  dimensions: string[];
  /** Max rows after NON EMPTY. 0 = no HEAD (full result). */
  maxCells: number;
  /** Per-dimension filters: single string → WHERE; array → axis member set. */
  filters?: Record<string, SampleCellFilter>;
  /** Dimension placed on COLUMNS. Default: last cube dimension. */
  axisDimension?: string;
  /** If true, restrict unfiltered dims to leaf members (level 0). */
  leavesOnly: boolean;
}

export interface SampleCellsBuildResult {
  mdx: string;
  /** Dimensions pinned via WHERE (single-string filters). */
  whereDims: string[];
  /** Dimensions on the ROW crossjoin axis. */
  rowDims: string[];
  /** Dimension placed on COLUMNS. */
  columnDim: string;
}

export interface SampleCell {
  coordinates: Record<string, string>;
  value: CellValue;
  formattedValue: string;
}

/** Escape `]` in MDX bracketed identifiers per OLAP convention. */
const escapeMdxName = (s: string): string => s.replace(/]/g, "]]");

const memberRef = (dim: string, elem: string): string => {
  // Pre-qualified pass-through (e.g. caller passes "[Dim].[Elem]").
  if (elem.startsWith("[") && elem.includes("].[")) return elem;
  return `[${dim}].[${escapeMdxName(elem)}]`;
};

export function buildSampleCellsMdx(args: SampleCellsBuildArgs): SampleCellsBuildResult {
  const { cubeName, dimensions, maxCells, filters = {}, leavesOnly } = args;

  if (dimensions.length === 0) {
    throw new Error(`Cube '${cubeName}' has no dimensions`);
  }

  const columnDim = args.axisDimension ?? dimensions[dimensions.length - 1];
  if (!dimensions.includes(columnDim)) {
    throw new Error(
      `axisDimension '${columnDim}' is not a dimension of cube '${cubeName}' (dims: ${dimensions.join(", ")})`,
    );
  }

  for (const key of Object.keys(filters)) {
    if (!dimensions.includes(key)) {
      throw new Error(
        `Filter dimension '${key}' is not a dimension of cube '${cubeName}' (dims: ${dimensions.join(", ")})`,
      );
    }
  }

  const whereDims: string[] = [];
  const whereParts: string[] = [];
  const rowDims: string[] = [];
  const rowSets: string[] = [];

  for (const dim of dimensions) {
    if (dim === columnDim) continue;
    const f = filters[dim];
    if (typeof f === "string") {
      whereDims.push(dim);
      whereParts.push(memberRef(dim, f));
      continue;
    }
    if (Array.isArray(f) && f.length > 0) {
      rowDims.push(dim);
      rowSets.push(`{${f.map((e) => memberRef(dim, e)).join(",")}}`);
      continue;
    }
    rowDims.push(dim);
    rowSets.push(
      leavesOnly
        ? `TM1FILTERBYLEVEL({TM1SUBSETALL([${dim}])},0)`
        : `{TM1SUBSETALL([${dim}])}`,
    );
  }

  const colFilter = filters[columnDim];
  let columnSet: string;
  if (typeof colFilter === "string") {
    columnSet = `{${memberRef(columnDim, colFilter)}}`;
  } else if (Array.isArray(colFilter) && colFilter.length > 0) {
    columnSet = `{${colFilter.map((e) => memberRef(columnDim, e)).join(",")}}`;
  } else {
    columnSet = `{[${columnDim}].DefaultMember}`;
  }

  let rowExpr: string;
  if (rowSets.length === 0) {
    rowExpr = `{[${columnDim}].DefaultMember}`;
  } else if (rowSets.length === 1) {
    rowExpr = rowSets[0];
  } else {
    rowExpr = rowSets.reduce((acc, s) => `CROSSJOIN(${acc},${s})`);
  }

  // TM1's NONEMPTY(set, filterSet) is a set function. Plain "NON EMPTY <set>"
  // is an axis modifier and is rejected as a syntax error inside HEAD().
  const nonEmptyExpr = `NONEMPTY(${rowExpr},${columnSet})`;
  const rowAxisExpr = maxCells > 0 ? `HEAD(${nonEmptyExpr},${maxCells})` : nonEmptyExpr;

  const whereClause = whereParts.length > 0 ? ` WHERE (${whereParts.join(",")})` : "";
  const mdx = `SELECT ${columnSet} ON COLUMNS, ${rowAxisExpr} ON ROWS FROM [${cubeName}]${whereClause}`;

  return { mdx, whereDims, rowDims, columnDim };
}

export interface TransformArgs {
  result: MdxResult;
  whereCoords: Record<string, string>;
}

/**
 * Convert flat MdxResult cells into self-describing {coordinates,value,formattedValue}.
 * Assumes axes[0] = COLUMNS, axes[1] = ROWS (TM1 default ordering).
 */
export function transformSampleCells(args: TransformArgs): SampleCell[] {
  const { result, whereCoords } = args;
  const axes = result.axes;
  if (axes.length === 0) return [];

  const colAxis = axes[0];
  const rowAxis = axes[1] ?? { tuples: [{ members: [] }] };

  const colCount = colAxis.tuples.length;
  if (colCount === 0) return [];

  const out: SampleCell[] = [];
  for (let i = 0; i < result.cells.length; i++) {
    const colIdx = i % colCount;
    const rowIdx = Math.floor(i / colCount);
    const colTuple = colAxis.tuples[colIdx];
    const rowTuple = rowAxis.tuples[rowIdx];
    if (!colTuple || !rowTuple) continue;

    const coords: Record<string, string> = { ...whereCoords };
    for (const m of colTuple.members) coords[m.hierarchyName] = m.name;
    for (const m of rowTuple.members) coords[m.hierarchyName] = m.name;

    const c = result.cells[i];
    out.push({
      coordinates: coords,
      value: c.value,
      formattedValue: c.formattedValue,
    });
  }
  return out;
}
