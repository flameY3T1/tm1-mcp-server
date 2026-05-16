// Cell domain service. Owns single-cell reads, MDX cellset execution, and
// cell writes via the cellset PATCH path. Cube-shape lookups (resolving
// dimension order for getValue) go through the request layer directly rather
// than CubeService to avoid a CubeService → CellService cycle later.
//
// See docs/ARCHITECTURE.md for the layering.
import { TM1Error, TM1ErrorCode } from "../../types.js";
import type { CellValue, MdxResult } from "../../types.js";
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
    const qualified = dims.map((d, i) => qualify(d, elements[i]));

    const colMember = qualified[0];
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
      return cellsetResponse.Cells[0].Value;
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
    }
  }
}
