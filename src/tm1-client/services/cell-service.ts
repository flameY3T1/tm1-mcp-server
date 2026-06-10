// Cell domain service. Owns single-cell reads, MDX cellset execution, and
// cell writes via the cellset PATCH path. Cube-shape lookups (resolving
// dimension order for getValue) go through the request layer directly rather
// than CubeService to avoid a CubeService → CellService cycle later.
//
// See docs/ARCHITECTURE.md for the layering.
import { TM1Error, TM1ErrorCode } from "../../types.js";
import type {
  CalculationTraceNode,
  CellValue,
  FedCellDescriptor,
  FeederTraceResult,
  MdxResult,
} from "../../types.js";
import type { RequestOptions, TM1HttpClient } from "../http.js";
import { transformCellsetResponse } from "./cellset-transform.js";

const enc = encodeURIComponent;

export class CellService {
  constructor(private readonly http: TM1HttpClient) {}

  /**
   * Get a single cell value via a 1-tuple MDX query.
   *
   * TM1 11.8 returns 0 cells for `SELECT {} ON COLUMNS WHERE (...)` — the
   * empty axis collapses the cellset. Put the first element on COLUMNS and
   * the rest in WHERE to force a 1-cell cellset. Each element is qualified
   * with its dimension to avoid name collisions in control cubes.
   */
  async getValue(cubeName: string, elements: string[]): Promise<CellValue> {
    if (elements.length === 0) {
      return null;
    }

    const cubePath = `/api/v1/Cubes('${enc(cubeName)}')?$expand=Dimensions($select=Name)`;
    const cubeMeta = await this.http.request<{ Name: string; Dimensions: Array<{ Name: string }> }>(
      "GET",
      cubePath,
    );
    const dims = cubeMeta.Dimensions.map((d) => d.Name);
    if (elements.length !== dims.length) {
      throw new Error(
        `Cube '${cubeName}' has ${dims.length} dimension(s) (${dims.join(", ")}) but ${elements.length} element(s) were given`,
      );
    }
    const qualify = (dim: string, element: string): string => {
      // Pre-qualified MDX member reference — pass through.
      if (element.startsWith("[") && element.includes("].[")) return element;
      // Single bracketed member like `[Foo]` — prepend dimension.
      if (element.startsWith("[") && element.endsWith("]")) return `[${dim}].${element}`;
      return `[${dim}].[${element}]`;
    };
    const qualified = dims.map((d, i) => qualify(d, elements[i]!));

    const colMember = qualified[0]!;
    const whereParts = qualified.slice(1);
    const mdx =
      whereParts.length === 0
        ? `SELECT {${colMember}} ON COLUMNS FROM [${cubeName}]`
        : `SELECT {${colMember}} ON COLUMNS FROM [${cubeName}] WHERE (${whereParts.join(",")})`;

    const cellsetResponse = await this.http.request<{
      ID: string;
      Cells?: Array<{ Value: CellValue; FormattedValue: string }>;
    }>("POST", "/api/v1/ExecuteMDX?$expand=Cells($select=Value,FormattedValue)", { MDX: mdx });

    if (cellsetResponse.Cells && cellsetResponse.Cells.length > 0) {
      return cellsetResponse.Cells[0]!.Value;
    }

    return null;
  }

  /**
   * Execute an MDX query and return structured cells + axes. Supports
   * pagination via top/skip on the Cells expand. opts.timeoutMs overrides the
   * 30s default for heavy queries.
   * POST /api/v1/ExecuteMDX
   */
  async executeMdx(
    mdx: string,
    top?: number,
    skip?: number,
    opts?: RequestOptions,
  ): Promise<MdxResult> {
    let cellsExpand = "Cells($select=Value,FormattedValue";
    if (top !== undefined) {
      cellsExpand += `;$top=${top}`;
    }
    if (skip !== undefined) {
      cellsExpand += `;$skip=${skip}`;
    }
    cellsExpand += ")";

    const axesExpand = "Axes($expand=Tuples($expand=Members($select=Name;$expand=Hierarchy($select=Name))))";
    const path = `/api/v1/ExecuteMDX?$expand=${cellsExpand},${axesExpand}`;

    const response = await this.http.request<{
      ID: string;
      Cells: Array<{ Value: CellValue; FormattedValue: string }>;
      Axes: Array<{
        Tuples: Array<{
          Members: Array<{
            Name: string;
            Hierarchy: { Name: string };
          }>;
        }>;
      }>;
    }>("POST", path, { MDX: mdx }, opts);

    return transformCellsetResponse(response);
  }

  /**
   * Write multiple cells via the cellset PATCH path.
   *
   * TM1 11.8's Cube /tm1.Update action rejects every documented payload
   * variant ("Invalid CellDescriptor property" / "Unexpected entity reference
   * type" / "Expecting Object or EntityBind"). The cellset PATCH path is the
   * supported route in 11.8:
   *   1. POST /api/v1/ExecuteMDX with a slice MDX over the target cell
   *   2. PATCH /api/v1/Cellsets('{id}')/Cells(0) with {Value}
   *   3. DELETE /api/v1/Cellsets('{id}')
   *
   * Values can be numeric (for N-cubes) or strings (for string cells). Writes
   * to consolidated cells are rejected by TM1.
   *
   * Prefer TI processes for reproducible data loads. Use this REST path only
   * for ad-hoc / debugging writes.
   */
  async writeCells(
    cubeName: string,
    dimensions: string[],
    cells: Array<{ elements: string[]; value: number | string }>,
  ): Promise<void> {
    if (cells.length === 0) return;

    for (const c of cells) {
      if (c.elements.length !== dimensions.length) {
        throw new TM1Error({
          code: TM1ErrorCode.VALIDATION_ERROR,
          message: `Cell tuple length (${c.elements.length}) does not match dimension count (${dimensions.length}) for cube '${cubeName}'.`,
        });
      }
    }

    const writeOne = async (c: { elements: string[]; value: number | string }) => {
      const memberRefs = c.elements.map(
        (e, idx) => `[${dimensions[idx]}].[${dimensions[idx]}].[${e}]`,
      );
      const colMember = memberRefs[0];
      const rowTuple = memberRefs.slice(1).join(",");
      const mdx =
        memberRefs.length === 1
          ? `SELECT {${colMember}} ON COLUMNS FROM [${cubeName}]`
          : `SELECT {${colMember}} ON COLUMNS, {(${rowTuple})} ON ROWS FROM [${cubeName}]`;

      const cellset = await this.http.request<{ ID: string }>(
        "POST",
        "/api/v1/ExecuteMDX",
        { MDX: mdx },
      );
      const id = cellset.ID;

      try {
        await this.http.request<void>(
          "PATCH",
          `/api/v1/Cellsets('${enc(id)}')/Cells(0)`,
          { Value: c.value },
        );
      } finally {
        try {
          await this.http.request<void>(
            "DELETE",
            `/api/v1/Cellsets('${enc(id)}')`,
          );
        } catch {
          // cleanup best-effort
        }
      }
    };

    const BATCH_SIZE = 10;
    for (let i = 0; i < cells.length; i += BATCH_SIZE) {
      await Promise.all(cells.slice(i, i + BATCH_SIZE).map(writeOne));
    }
  }

  /**
   * Resolve the cube's dimension order and build Tuple@odata.bind paths for
   * the cell-bound trace actions. Elements address the default hierarchy
   * (same name as the dimension) — alternate hierarchies are not supported
   * by these diagnostics tools.
   */
  private async tupleBinds(cubeName: string, elements: string[]): Promise<string[]> {
    const cubeMeta = await this.http.request<{ Dimensions: Array<{ Name: string }> }>(
      "GET",
      `/api/v1/Cubes('${enc(cubeName)}')?$expand=Dimensions($select=Name)`,
    );
    const dims = cubeMeta.Dimensions.map((d) => d.Name);
    if (elements.length !== dims.length) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: `Cube '${cubeName}' has ${dims.length} dimension(s) (${dims.join(", ")}) but ${elements.length} element(s) were given`,
      });
    }
    return dims.map(
      (d, i) => `Dimensions('${enc(d)}')/Hierarchies('${enc(d)}')/Elements('${enc(elements[i]!)}')`,
    );
  }

  /**
   * Check the feeders of a cell: returns the cells fed by this cell with a
   * Fed flag per target — Fed=false marks a broken/missing feeder. v11 only.
   * POST /api/v1/Cubes('{cube}')/tm1.CheckFeeders
   */
  async checkFeeders(
    cubeName: string,
    elements: string[],
    opts?: RequestOptions,
  ): Promise<FedCellDescriptor[]> {
    const binds = await this.tupleBinds(cubeName, elements);
    const response = await this.http.request<{
      value?: Array<RawFedCell>;
    }>(
      "POST",
      `/api/v1/Cubes('${enc(cubeName)}')/tm1.CheckFeeders?$expand=Cube($select=Name),Tuple($select=Name)`,
      { "Tuple@odata.bind": binds },
      opts,
    );
    return (response.value ?? []).map(mapFedCell);
  }

  /**
   * Trace the feeders of a cell: returns the cells this cell feeds plus the
   * feeder statements involved. v11 only.
   * POST /api/v1/Cubes('{cube}')/tm1.TraceFeeders
   */
  async traceFeeders(
    cubeName: string,
    elements: string[],
    opts?: RequestOptions,
  ): Promise<FeederTraceResult> {
    const binds = await this.tupleBinds(cubeName, elements);
    const response = await this.http.request<{
      FedCells?: Array<RawFedCell>;
      Statements?: string[];
    }>(
      "POST",
      `/api/v1/Cubes('${enc(cubeName)}')/tm1.TraceFeeders?$expand=FedCells/Cube($select=Name),FedCells/Tuple($select=Name)`,
      { "Tuple@odata.bind": binds },
      opts,
    );
    return {
      fedCells: (response.FedCells ?? []).map(mapFedCell),
      statements: response.Statements ?? [],
    };
  }

  /**
   * Trace how a cell value is calculated: recursive component tree with
   * per-component type (consolidation/rule), status, value, and rule
   * statements. The server returns the full tree; maxDepth/maxComponents
   * truncate client-side to keep responses bounded. v11 only.
   * POST /api/v1/Cubes('{cube}')/tm1.TraceCellCalculation
   */
  async traceCellCalculation(
    cubeName: string,
    elements: string[],
    maxDepth = 3,
    maxComponents = 20,
    opts?: RequestOptions,
  ): Promise<CalculationTraceNode> {
    const binds = await this.tupleBinds(cubeName, elements);
    // Components is a complex-type collection — nested nav-prop expand uses
    // the path form (Components/Tuple); ($levels=...) is rejected by 11.8.
    // Each path segment covers exactly one tree level, so emit one
    // Components/.../{Tuple,Cube} pair per requested depth — without them,
    // deeper nodes carry values but no coordinates (and no cube for
    // cross-cube DB() components), making drill-down impossible.
    const expandParts = ["Tuple($select=Name)"];
    for (let level = 1; level <= maxDepth; level++) {
      const prefix = "Components/".repeat(level);
      expandParts.push(`${prefix}Tuple($select=Name)`, `${prefix}Cube($select=Name)`);
    }
    const response = await this.http.request<RawCalcComponent>(
      "POST",
      `/api/v1/Cubes('${enc(cubeName)}')/tm1.TraceCellCalculation?$expand=${expandParts.join(",")}`,
      { "Tuple@odata.bind": binds },
      opts,
    );
    return mapCalcComponent(response, maxDepth, maxComponents);
  }
}

// Raw OData shapes for the trace actions. Cube/Tuple are navigation
// properties — present only when the $expand is honored, hence optional.
interface RawFedCell {
  Cube?: { Name?: string };
  Tuple?: Array<{ Name?: string }>;
  Fed?: boolean;
}

interface RawCalcComponent {
  Type?: string;
  Status?: string;
  Value?: CellValue;
  Cube?: { Name?: string };
  Tuple?: Array<{ Name?: string }>;
  Statements?: string[];
  Components?: RawCalcComponent[];
}

function mapFedCell(raw: RawFedCell): FedCellDescriptor {
  return {
    cube: raw.Cube?.Name ?? "",
    tuple: (raw.Tuple ?? []).map((t) => t.Name ?? ""),
    fed: raw.Fed === true,
  };
}

function mapCalcComponent(
  raw: RawCalcComponent,
  depthLeft: number,
  maxComponents: number,
): CalculationTraceNode {
  const node: CalculationTraceNode = { value: raw.Value ?? null };
  if (raw.Type !== undefined) node.type = raw.Type;
  if (raw.Status !== undefined) node.status = raw.Status;
  if (raw.Cube?.Name !== undefined) node.cube = raw.Cube.Name;
  if (raw.Tuple !== undefined) node.tuple = raw.Tuple.map((t) => t.Name ?? "");
  if (raw.Statements !== undefined && raw.Statements.length > 0) node.statements = raw.Statements;

  const children = raw.Components ?? [];
  if (children.length > 0) {
    if (depthLeft <= 0) {
      node.truncated = true;
    } else {
      const kept = children.slice(0, maxComponents);
      node.components = kept.map((c) => mapCalcComponent(c, depthLeft - 1, maxComponents));
      if (children.length > maxComponents) node.truncated = true;
    }
  }
  return node;
}
