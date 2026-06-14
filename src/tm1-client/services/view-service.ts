// View domain service. Owns the OData calls under
// /api/v1/Cubes('{c}')/Views and /PrivateViews — list, create (MDX-based),
// delete, execute (getView), and the structural definition (getDefinition)
// that returns either MDX or NativeView (titles/columns/rows) without
// executing.
//
// See docs/ARCHITECTURE.md for the layering.
import { TM1Error, TM1ErrorCode } from "../../types.js";
import type {
  CellValue,
  CubeView,
  NativeViewAxisSpec,
  NativeViewCreate,
  NativeViewTitleSpec,
  ViewDefinition,
  ViewResult,
} from "../../types.js";
import type { TM1HttpClient } from "../http.js";
import { transformCellsetResponse } from "./cellset-transform.js";
import { rethrowIfSystemic } from "./fallback.js";

// OData key encoder: double ' per OData literal rules, then percent-encode.
const enc = (s: string): string => encodeURIComponent(String(s).replace(/'/g, "''"));

export class ViewService {
  constructor(private readonly http: TM1HttpClient) {}

  /**
   * List public + private views on a cube. Each view's MDX is included if it
   * is an MDXView; native views surface with mdx=undefined.
   * GET /api/v1/Cubes('{c}')/Views + /PrivateViews
   */
  async list(cubeName: string): Promise<CubeView[]> {
    const result: CubeView[] = [];
    try {
      const pub = await this.http.request<{ value: Array<{ Name: string; MDX?: string }> }>(
        "GET",
        `/api/v1/Cubes('${enc(cubeName)}')/Views?$select=Name,MDX`,
      );
      result.push(...pub.value.map((v) => ({ name: v.Name, mdx: v.MDX, private: false })));
    } catch (e) {
      rethrowIfSystemic(e);
      // no public views
    }
    try {
      const priv = await this.http.request<{ value: Array<{ Name: string; MDX?: string }> }>(
        "GET",
        `/api/v1/Cubes('${enc(cubeName)}')/PrivateViews?$select=Name,MDX`,
      );
      result.push(...priv.value.map((v) => ({ name: v.Name, mdx: v.MDX, private: true })));
    } catch (e) {
      rethrowIfSystemic(e);
      // no private views
    }
    return result;
  }

  /**
   * Execute a named view and return its cells + axes.
   * POST /api/v1/Cubes('{c}')/Views('{v}')/tm1.Execute
   */
  async getView(cubeName: string, viewName: string): Promise<ViewResult> {
    const axesExpand = "Axes($expand=Tuples($expand=Members($select=Name;$expand=Hierarchy($select=Name))))";
    const path = `/api/v1/Cubes('${enc(cubeName)}')/Views('${enc(viewName)}')/tm1.Execute?$expand=Cells($select=Value,FormattedValue),${axesExpand}`;

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
    }>("POST", path);

    const mdxResult = transformCellsetResponse(response);

    return {
      cubeName,
      viewName,
      cells: mdxResult.cells,
      axes: mdxResult.axes,
    };
  }

  /**
   * Return the structural definition of a view (MDX expression OR native
   * axes) WITHOUT executing it. Auto-falls back from public to private when
   * isPrivate is undefined.
   * GET /api/v1/Cubes('X')/Views('Y') with tm1.NativeView/* expands.
   */
  async getDefinition(
    cubeName: string,
    viewName: string,
    isPrivate?: boolean,
  ): Promise<ViewDefinition> {
    type RawSubset = {
      Name?: string;
      Expression?: string;
      Hierarchy?: { Name?: string; Dimension?: { Name?: string } };
    };
    type RawAxis = { Subset?: RawSubset };
    type RawTitle = RawAxis & { Selected?: { Name?: string } };
    type RawBase = { Name: string; MDX?: string | null };
    type RawNative = {
      Titles?: RawTitle[];
      Columns?: RawAxis[];
      Rows?: RawAxis[];
    };

    const fetchBase = async (
      segment: "Views" | "PrivateViews",
    ): Promise<RawBase> => {
      const path = `/api/v1/Cubes('${enc(cubeName)}')/${segment}('${enc(viewName)}')?$select=Name,MDX`;
      return this.http.request<RawBase>("GET", path);
    };

    const order: Array<{ seg: "Views" | "PrivateViews"; priv: boolean }> =
      isPrivate === true
        ? [{ seg: "PrivateViews", priv: true }]
        : isPrivate === false
          ? [{ seg: "Views", priv: false }]
          : [
              { seg: "Views", priv: false },
              { seg: "PrivateViews", priv: true },
            ];

    let base: RawBase | null = null;
    let resolvedSeg: "Views" | "PrivateViews" = "Views";
    let resolvedPrivate = false;
    let lastErr: unknown = null;
    for (const { seg, priv } of order) {
      try {
        base = await fetchBase(seg);
        resolvedSeg = seg;
        resolvedPrivate = priv;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!base) {
      if (lastErr instanceof TM1Error) throw lastErr;
      throw new TM1Error({
        code: TM1ErrorCode.NOT_FOUND,
        message: `View not found: ${cubeName}/${viewName}`,
        endpoint: `/api/v1/Cubes('${cubeName}')/Views('${viewName}')`,
      });
    }

    const isMdx = typeof base.MDX === "string" && base.MDX.length > 0;
    if (isMdx) {
      return {
        cubeName,
        viewName,
        private: resolvedPrivate,
        type: "MDX",
        mdx: base.MDX as string,
      };
    }

    // Titles/Columns/Rows are complex-type collections — TM1 11.8 rejects
    // parenthesized expand options directly on them ("Expecting '/' after
    // property of complex type in expand path") AND pure path form past the
    // entity ("Expecting qualified entity type"). Working syntax
    // (live-verified on 11.8): path through the complex part, parenthesized
    // options from the first entity (Subset) on.
    const subsetExpand = "Subset($expand=Hierarchy($expand=Dimension))";
    const nativeExpand = [
      `Titles/${subsetExpand}`,
      "Titles/Selected",
      `Columns/${subsetExpand}`,
      `Rows/${subsetExpand}`,
    ].join(",");
    const nativePath = `/api/v1/Cubes('${enc(cubeName)}')/${resolvedSeg}('${enc(viewName)}')/tm1.NativeView?$expand=${nativeExpand}`;

    let native: RawNative;
    try {
      native = await this.http.request<RawNative>("GET", nativePath);
    } catch (e) {
      if (e instanceof TM1Error && e.httpStatus === 404) {
        return {
          cubeName,
          viewName,
          private: resolvedPrivate,
          type: "Native",
          native: { titles: [], columns: [], rows: [] },
        };
      }
      throw e;
    }

    const mapAxis = (a: RawAxis) => {
      const s = a.Subset ?? {};
      return {
        dimensionName: s.Hierarchy?.Dimension?.Name,
        hierarchyName: s.Hierarchy?.Name,
        subsetName: s.Name && s.Name.length > 0 ? s.Name : undefined,
        expression: s.Expression && s.Expression.length > 0 ? s.Expression : undefined,
      };
    };
    const mapTitle = (t: RawTitle) => ({
      ...mapAxis(t),
      selectedElement: t.Selected?.Name,
    });

    return {
      cubeName,
      viewName,
      private: resolvedPrivate,
      type: "Native",
      native: {
        titles: (native.Titles ?? []).map(mapTitle),
        columns: (native.Columns ?? []).map(mapAxis),
        rows: (native.Rows ?? []).map(mapAxis),
      },
    };
  }

  /**
   * Create a public MDX-based view on a cube.
   * POST /api/v1/Cubes('{c}')/Views with @odata.type = #ibm.tm1.api.v1.MDXView
   */
  async createMdx(cubeName: string, viewName: string, mdx: string): Promise<void> {
    await this.http.request<void>(
      "POST",
      `/api/v1/Cubes('${enc(cubeName)}')/Views`,
      {
        "@odata.type": "#ibm.tm1.api.v1.MDXView",
        Name: viewName,
        MDX: mdx,
      },
    );
  }

  /**
   * Create a public native view on a cube. Each axis entry references exactly
   * one subset source: a registered subset (`subset`), an MDX expression
   * (`expression`), or an explicit element list (`elements`). The latter two
   * create anonymous (view-private) subsets server-side.
   * POST /api/v1/Cubes('{c}')/Views with @odata.type = #ibm.tm1.api.v1.NativeView
   */
  async createNative(
    cubeName: string,
    viewName: string,
    spec: NativeViewCreate,
  ): Promise<void> {
    const hierPath = (a: NativeViewAxisSpec): string =>
      `Dimensions('${enc(a.dimension)}')/Hierarchies('${enc(a.hierarchy ?? a.dimension)}')`;

    const mapAxis = (a: NativeViewAxisSpec): Record<string, unknown> => {
      const sources = [a.subset, a.expression, a.elements].filter((s) => s !== undefined);
      if (sources.length !== 1) {
        throw new TM1Error({
          code: TM1ErrorCode.VALIDATION_ERROR,
          message:
            `Axis spec for dimension '${a.dimension}' must set exactly one of ` +
            `subset, expression, or elements.`,
          endpoint: `/api/v1/Cubes('${cubeName}')/Views`,
        });
      }
      if (a.subset !== undefined) {
        return { "Subset@odata.bind": `${hierPath(a)}/Subsets('${enc(a.subset)}')` };
      }
      if (a.expression !== undefined) {
        return { Subset: { "Hierarchy@odata.bind": hierPath(a), Expression: a.expression } };
      }
      return {
        Subset: {
          "Hierarchy@odata.bind": hierPath(a),
          "Elements@odata.bind": (a.elements ?? []).map((e) => `${hierPath(a)}/Elements('${enc(e)}')`),
        },
      };
    };

    const mapTitle = (t: NativeViewTitleSpec): Record<string, unknown> => {
      // TM1 rejects title subsets without a selected element (400: "Selected
      // element was not specified on Title axis subset.") — fail fast here.
      if (t.selected === undefined) {
        throw new TM1Error({
          code: TM1ErrorCode.VALIDATION_ERROR,
          message:
            `Title spec for dimension '${t.dimension}' requires a selected element ` +
            `(TM1 rejects title subsets without one).`,
          endpoint: `/api/v1/Cubes('${cubeName}')/Views`,
        });
      }
      const axis = mapAxis(t);
      axis["Selected@odata.bind"] = `${hierPath(t)}/Elements('${enc(t.selected)}')`;
      return axis;
    };

    const body: Record<string, unknown> = {
      "@odata.type": "#ibm.tm1.api.v1.NativeView",
      Name: viewName,
      Columns: spec.columns.map(mapAxis),
      Rows: spec.rows.map(mapAxis),
      Titles: (spec.titles ?? []).map(mapTitle),
      SuppressEmptyColumns: spec.suppressEmptyColumns ?? false,
      SuppressEmptyRows: spec.suppressEmptyRows ?? false,
    };
    if (spec.formatString !== undefined) body.FormatString = spec.formatString;

    await this.http.request<void>("POST", `/api/v1/Cubes('${enc(cubeName)}')/Views`, body);
  }

  /**
   * Delete a public view from a cube.
   * DELETE /api/v1/Cubes('{c}')/Views('{v}')
   */
  async delete(cubeName: string, viewName: string): Promise<void> {
    await this.http.request<void>(
      "DELETE",
      `/api/v1/Cubes('${enc(cubeName)}')/Views('${enc(viewName)}')`,
    );
  }
}
