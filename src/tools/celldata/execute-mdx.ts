import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import type { MdxAxis, CellValue } from "../../types.js";
import { PAGINATION_SCHEMA } from "../pagination.js";
import { FORMAT_SCHEMA, payloadResponse } from "../format.js";
import { withToolHint } from "../error-format.js";

export interface MdxEnvelope {
  axes: MdxAxis[];
  total: number | null;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset: number | null;
  items: Array<{ value: CellValue; formattedValue: string }>;
}

function mdCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

const tupleLabel = (tuple: MdxAxis["tuples"][number]): string =>
  tuple.members.map((m) => m.name).join(" / ");

const axisHeader = (axis: MdxAxis): string =>
  axis.tuples[0]?.members.map((m) => m.hierarchyName).join(" / ") || "Axis";

const cellText = (c: { value: CellValue; formattedValue: string }): string =>
  c.formattedValue !== "" ? c.formattedValue : mdCell(c.value);

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
  const fullSet = items.length === axes.reduce((a, ax) => a * ax.tuples.length, 1);
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
      .map((ax) => mdCell(tupleLabel(ax.tuples[0]!)))
      .filter((s) => s.length > 0)
      .join(" · ");
    const head = context ? [meta, "", `**Context:** ${context}`] : [meta];
    const header = `| ${mdCell(axisHeader(axes[1]!))} | ${cols.map((t) => mdCell(tupleLabel(t))).join(" | ")} |`;
    const sep = `| ${["---", ...cols.map(() => "---")].join(" | ")} |`;
    const body = rows.map((rt, r) => {
      const vals = cols.map((_, c) => mdCell(cellText(items[r * colCount + c]!)));
      return `| ${mdCell(tupleLabel(rt))} | ${vals.join(" | ")} |`;
    });
    return [...head, "", header, sep, ...body].join("\n");
  }

  // Flat fallback: decode each cell's coordinate from its global ordinal.
  const radices = axes.map((a) => a.tuples.length);
  const header = `| ${[...axes.map((a) => mdCell(axisHeader(a))), "Value"].join(" | ")} |`;
  const sep = `| ${[...axes.map(() => "---"), "---"].join(" | ")} |`;
  const body = items.map((cell, i) => {
    let ord = offset + i;
    const coords = radices.map((n, k) => {
      const idx = ord % n;
      ord = Math.floor(ord / n);
      return mdCell(tupleLabel(axes[k]!.tuples[idx]!));
    });
    return `| ${[...coords, mdCell(cellText(cell))].join(" | ")} |`;
  });
  return [meta, "", header, sep, ...body].join("\n");
}

export function registerExecuteMdx(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_execute_mdx",
    [
      "Execute an MDX query against the TM1 server and return structured cell data with axes (page-envelope shape consistent with list_*).",
      "format='markdown' renders a pivot grid (2 axes, full result — set fetchAll=true to avoid a partial grid) or a flat coordinate table; 'json' (default) returns the structured envelope.",
      "Related: tm1_create_mdx_view to persist a query as a public view, tm1_sample_cells for cheap sparsity probe, tm1_get_cell_value for a single coordinate.",
    ].join(" "),
    {
      mdx: z.string().describe("The MDX query string to execute"),
      ...PAGINATION_SCHEMA,
      ...FORMAT_SCHEMA,
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(3600000)
        .optional()
        .describe("Override the default 30s request timeout for this call (ms, 1000–3600000). Use for heavy MDX over wide views."),
    },
    async ({ mdx, limit, offset, fetchAll, format, timeoutMs }, extra) => {
      const all = fetchAll === true || limit === 0;
      const top = all ? undefined : limit;
      const skip = all ? undefined : offset;
      const result = await withToolHint(
        tm1Client.cells.executeMdx(mdx, top, skip, { signal: extra?.signal, ...(timeoutMs ? { timeoutMs } : {}) }),
        "MDX execution failed. Common causes: missing brackets around member names ([Dim].[Hier].[Member]), unbalanced FROM/SELECT, unknown cube. Inspect details; cross-check member names with tm1_get_hierarchy or tm1_list_cubes.",
      );

      const total = result.totalCellCount;
      const count = result.cells.length;
      const off = all ? 0 : offset;
      const has_more = !all && off + count < total;
      const envelope: MdxEnvelope = {
        axes: result.axes,
        total,
        count,
        offset: off,
        has_more,
        next_offset: has_more ? off + count : null,
        items: result.cells,
      };
      return payloadResponse(envelope, format, renderMdxMarkdown);
    },
  );
}
