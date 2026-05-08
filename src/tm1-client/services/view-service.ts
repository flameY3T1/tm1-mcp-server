// View domain service. Owns the OData calls under
// /api/v1/Cubes('{c}')/Views and /PrivateViews — list, create (MDX-based),
// delete, execute (getView), and the structural definition (getDefinition)
// that returns either MDX or NativeView (titles/columns/rows) without
// executing.
//
// See docs/ARCHITECTURE.md for the layering.
import { TM1Error, TM1ErrorCode } from "../../types.js";
import type { CellValue, CubeView, ViewDefinition, ViewResult } from "../../types.js";
import type { TM1HttpClient } from "../http.js";
import { transformCellsetResponse } from "./cellset-transform.js";

const enc = encodeURIComponent;

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
    } catch {
      // no public views
    }
    try {
      const priv = await this.http.request<{ value: Array<{ Name: string; MDX?: string }> }>(
        "GET",
        `/api/v1/Cubes('${enc(cubeName)}')/PrivateViews?$select=Name,MDX`,
      );
      result.push(...priv.value.map((v) => ({ name: v.Name, mdx: v.MDX, private: true })));
    } catch {
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

    const subsetExpand =
      "Subset($select=Name,Expression;$expand=Hierarchy($select=Name;$expand=Dimension($select=Name)))";
    const nativeExpand =
      `Titles($expand=${subsetExpand},Selected($select=Name)),` +
      `Columns($expand=${subsetExpand}),` +
      `Rows($expand=${subsetExpand})`;
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
