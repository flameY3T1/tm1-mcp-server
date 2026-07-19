// Cell-data schemas: MDX axes, execute_mdx / get_view page envelopes,
// sample_cells and check_writable_coords results.
import { z } from "zod";

import { CellValueSchema } from "./items-common.js";

export const MdxAxisSchema = z.object({
  tuples: z.array(
    z.object({
      members: z.array(
        z.object({ name: z.string(), hierarchyName: z.string() }),
      ),
    }),
  ),
});

// tm1_get_view returns the same page-envelope shape as tm1_execute_mdx
// (axes + paginated cell `items`), plus the cube/view it executed. Cells
// paginate server-side so wide/tall views can't dump their whole cellset.
export const ViewResultSchema = z.object({
  cubeName: z.string(),
  viewName: z.string(),
  axes: z.array(MdxAxisSchema),
  total: z.number().int().nullable(),
  count: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().nullable(),
  // Set only when axes were clipped to the returned cell page (see MdxResultSchema).
  axes_clipped: z.boolean().optional(),
  items: z.array(
    z.object({ value: CellValueSchema, formattedValue: z.string() }),
  ),
});

export const SampleCellsResultSchema = z.object({
  cubeName: z.string(),
  count: z.number().int(),
  truncated: z.boolean(),
  cells: z.array(
    z.object({
      coordinates: z.record(z.string(), z.string()),
      value: CellValueSchema,
      formattedValue: z.string(),
    }),
  ),
  filtersApplied: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  axisDimension: z.string(),
  rowDims: z.array(z.string()),
  whereDims: z.array(z.string()),
  mdxUsed: z.string(),
  elapsedMs: z.number().int(),
  hint: z.string().optional(),
});

// Composite results emitted by validation/check tools.

export const WritableCoordsResultSchema = z
  .object({
    cube: z.string(),
    writable: z.boolean(),
    allElementsExist: z.boolean(),
    allElementsNLevel: z.boolean(),
    coords: z.array(z.unknown()),
    ruleOverlapWarn: z.unknown().optional(),
  })
  .passthrough();

// Page-envelope shape consistent with list_* tools (Page<T>).
// `total` derives from axes (product of tuple counts) — null only when
// axes are absent and we cannot infer cell count cheaply.
export const MdxResultSchema = z.object({
  axes: z.array(MdxAxisSchema),
  total: z.number().int().nullable(),
  count: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().nullable(),
  // True only when `axes` were clipped to this page's cells; `total` stays full.
  axes_clipped: z.boolean().optional(),
  items: z.array(
    z.object({ value: CellValueSchema, formattedValue: z.string() }),
  ),
});
