import { z } from "zod";
import type { MdxAxis, CellValue } from "../../types.js";
import { PAGINATION_SCHEMA, UNBOUNDED_MAX_ITEMS } from "../pagination.js";
import { FORMAT_SCHEMA, mdEscape, payloadResponse } from "../format.js";
import { withToolHint } from "../error-format.js";
import { clipAxesToWindow } from "../../tm1-client/services/cellset-transform.js";
import { MdxResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { cleanSandboxName } from "../../lib/sandbox-policy.js";

export interface MdxEnvelope {
  axes: MdxAxis[];
  total: number | null;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset: number | null;
  // Present (true) only when `axes` were clipped to this page's cell window;
  // the omitted tuples address cells outside the page. `total` stays the full
  // cell count. Absent for full/small results so their output is unchanged.
  axes_clipped?: boolean;
  items: Array<{ value: CellValue; formattedValue: string }>;
}

const tupleLabel = (tuple: MdxAxis["tuples"][number]): string =>
  tuple.members.map((m) => m.name).join(" / ");

const axisHeader = (axis: MdxAxis): string =>
  axis.tuples[0]?.members.map((m) => m.hierarchyName).join(" / ") || "Axis";

const cellText = (c: { value: CellValue; formattedValue: string }): string =>
  c.formattedValue !== "" ? c.formattedValue : (c.value ?? "").toString();

// Render an MDX cellset envelope as Markdown.
//
// Pivot grid when axis[0] (ON COLUMNS) and axis[1] (ON ROWS) drive the result
// and every remaining axis is a single-tuple slicer/context (TM1 surfaces the
// WHERE clause as a trailing single-tuple axis). Requires the full result
// (offset 0, all cells). TM1 orders cells with axis[0] varying fastest and the
// single-tuple context axes contribute index 0 (×1), so cell(r,c) still maps
// to items[r*colCount + c]. Context tuples are noted above the grid.
//
// Anything else (0/1 axis, a genuine 3-D result, or a paginated slice where the
// grid can't be reconstructed) → a flat table: one row per cell, coordinates
// decoded from the global ordinal (offset + i), value last.
export function renderMdxMarkdown(env: MdxEnvelope): string {
  const { axes, items, total, count, offset, has_more } = env;
  const meta =
    `_MDX cellset — ${count}${total !== null ? ` of ${total}` : ""} cells` +
    `${offset > 0 ? `, offset ${offset}` : ""}${has_more ? ", more available" : ""}._`;

  if (axes.length === 0 || items.length === 0) {
    const scalar = items.length > 0 ? cellText(items[0]!) : "(no cells)";
    return `${meta}\n\n**Value:** ${scalar}`;
  }

  const contextAxes = axes.slice(2);
  const fullSet =
    items.length === axes.reduce((a, ax) => a * ax.tuples.length, 1);
  const isGrid =
    axes.length >= 2 &&
    offset === 0 &&
    fullSet &&
    contextAxes.every((ax) => ax.tuples.length === 1);

  if (isGrid) {
    const cols = axes[0]!.tuples;
    const rows = axes[1]!.tuples;
    const colCount = cols.length;
    const context = contextAxes
      .map((ax) => mdEscape(tupleLabel(ax.tuples[0]!)))
      .filter((s) => s.length > 0)
      .join(" · ");
    const head = context ? [meta, "", `**Context:** ${context}`] : [meta];
    const header = `| ${mdEscape(axisHeader(axes[1]!))} | ${cols.map((t) => mdEscape(tupleLabel(t))).join(" | ")} |`;
    const sep = `| ${["---", ...cols.map(() => "---")].join(" | ")} |`;
    const body = rows.map((rt, r) => {
      const vals = cols.map((_, c) =>
        mdEscape(cellText(items[r * colCount + c]!)),
      );
      return `| ${mdEscape(tupleLabel(rt))} | ${vals.join(" | ")} |`;
    });
    return [...head, "", header, sep, ...body].join("\n");
  }

  // Flat fallback: decode each cell's coordinate from its global ordinal.
  const radices = axes.map((a) => a.tuples.length);
  const header = `| ${[...axes.map((a) => mdEscape(axisHeader(a))), "Value"].join(" | ")} |`;
  const sep = `| ${[...axes.map(() => "---"), "---"].join(" | ")} |`;
  const body = items.map((cell, i) => {
    let ord = offset + i;
    const coords = radices.map((n, k) => {
      const idx = ord % n;
      ord = Math.floor(ord / n);
      return mdEscape(tupleLabel(axes[k]!.tuples[idx]!));
    });
    return `| ${[...coords, mdEscape(cellText(cell))].join(" | ")} |`;
  });
  return [meta, "", header, sep, ...body].join("\n");
}

export const registerExecuteMdx = defineTool({
  name: "tm1_execute_mdx",
  description: [
    "Execute an MDX query against the TM1 server and return structured cell data with axes (page-envelope shape consistent with list_*).",
    "format='markdown' renders a pivot grid (2 axes; set fetchAll=true to get up to 5000 cells in one grid) or a flat coordinate table; 'json' (default) returns the structured envelope.",
    "Related: tm1_create_mdx_view to persist a query as a public view, tm1_sample_cells for cheap sparsity probe, tm1_get_cell_value for a single coordinate.",
  ],
  annotations: READ_ONLY,
  output: MdxResultSchema,
  input: {
    mdx: z.string().describe("The MDX query string to execute"),
    ...PAGINATION_SCHEMA,
    ...FORMAT_SCHEMA,
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(3600000)
      .optional()
      .describe(
        "Override the default 30s request timeout for this call (ms, 1000–3600000). Use for heavy MDX over wide views.",
      ),
    sandbox: z
      .string()
      .optional()
      .describe("Evaluate the MDX in this sandbox instead of base data"),
  },
  handler: async (
    { mdx, limit, offset, fetchAll, format, timeoutMs, sandbox },
    tm1Client,
    extra,
  ) => {
    const all = fetchAll === true || limit === 0;
    // "All" is the documented first slab of UNBOUNDED_MAX_ITEMS, pushed down
    // to TM1 as $top — not the whole cellset. has_more/next_offset then say
    // where to resume, exactly as for any other page.
    const top = all ? UNBOUNDED_MAX_ITEMS : limit;
    const skip = all ? 0 : offset;
    const result = await withToolHint(
      tm1Client.cells.executeMdx(
        mdx,
        top,
        skip,
        {
          signal: extra?.signal,
          ...(timeoutMs ? { timeoutMs } : {}),
        },
        cleanSandboxName(sandbox),
      ),
      "MDX execution failed. Common causes: missing brackets around member names ([Dim].[Hier].[Member]), unbalanced FROM/SELECT, unknown cube. Inspect details; cross-check member names with tm1_get_hierarchy or tm1_list_cubes.",
    );

    const total = result.totalCellCount;
    const count = result.cells.length;
    const off = all ? 0 : offset;
    const has_more = off + count < total;
    // Clip axes to the returned cell page so a capped read over a huge view
    // doesn't ship the full tuple list.
    const { axes, clipped } = clipAxesToWindow(result.axes, count, off);
    const envelope: MdxEnvelope = {
      axes,
      total,
      count,
      offset: off,
      has_more,
      next_offset: has_more ? off + count : null,
      ...(clipped ? { axes_clipped: true } : {}),
      items: result.cells,
    };
    return payloadResponse(envelope, format, renderMdxMarkdown);
  },
});
