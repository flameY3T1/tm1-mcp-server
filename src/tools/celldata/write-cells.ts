import { z } from "zod";
import { TM1Error } from "../../types.js";
import { actionResponse } from "../format.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { memberRef } from "./member-ref.js";
import { resolveCellAddress, sandboxPosition } from "../../lib/cell-address.js";
import { resolveWriteSandbox } from "../../lib/sandbox-policy.js";

export const registerWriteCells = defineTool({
  name: "tm1_write_cells",
  description: [
    "Write one or more cell values directly to a TM1 cube via REST.",
    "IMPORTANT: TI processes are the standard path for data loads — use this tool only for ad-hoc writes or when explicitly requested.",
    "Leaf (N-level) coordinates only. Every coordinate is checked before anything is sent and a consolidated one aborts the whole call: writing to a C element is not how TM1 data is loaded, and whether the server would even accept it depends on the account's rights. Aggregate values come from the consolidation, not from a write.",
    "Name every cube dimension, in any order: a dimension left out would land on its default member, so the call is refused. Only Sandboxes may be left out; it is then bound to Base (or to `sandbox`) and reported as sandboxDefaulted.",
    "With `sandbox` the write lands in that sandbox and base data is untouched. With TM1_MODE=sandbox a sandbox named with TM1_SANDBOX_PREFIX is required.",
    "Before: tm1_check_writable_coords to validate that target coordinates are leaf-level and addressable.",
    "Related: tm1_clear_cube for bulk wipe, tm1_get_cell_value to read back, tm1_execute_process for production data loads.",
  ],
  annotations: DESTRUCTIVE,
  sandboxScoped: true,
  output: MutationResultSchema,
  input: {
    cubeName: z.string().describe("Name of the TM1 cube"),
    dimensions: z
      .array(z.string())
      .min(2)
      .describe(
        "Cube dimension names, any order; each cell's elements follow this order. Must cover every cube dimension except Sandboxes.",
      ),
    cells: z
      .array(
        z.object({
          elements: z
            .array(z.string())
            .describe(
              "Element names, one per entry in dimensions, in that order",
            ),
          value: z
            .union([z.number(), z.string()])
            .describe(
              "Cell value (number for Numeric cubes, string for String cells)",
            ),
        }),
      )
      .min(1)
      .describe("Cells to write"),
    sandbox: z
      .string()
      .optional()
      .describe(
        "Write into this sandbox instead of base data (required with TM1_MODE=sandbox)",
      ),
    ...CONFIRM_SCHEMA,
  },
  handler: async (
    { cubeName, dimensions: given, cells: givenCells, sandbox, confirm },
    tm1Client,
  ) => {
    // Overwrites prior cell values with no undo. Guards against an
    // auto-approve client firing this without intent — NOT a security
    // control: anything that can call the tool can also supply `confirm`.
    requireConfirm(confirm, cubeName, "cube");
    // Where the write lands. In sandbox mode this refuses base data and any
    // sandbox outside the prefix, before a single request goes out.
    const target = resolveWriteSandbox(tm1Client, sandbox);
    for (const c of givenCells) {
      if (c.elements.length !== given.length) {
        throw new TM1Error({
          code: "VALIDATION_ERROR",
          message: `Cell element count (${c.elements.length}) does not match dimension count (${given.length})`,
        });
      }
    }
    // Everything below works in cube order over the cube's full dimension
    // list, so a dimension the caller forgot can never reach the MDX tuple.
    const address = resolveCellAddress(
      cubeName,
      await tm1Client.cubes.getDimensionNames(cubeName),
      given,
    );
    const dimensions = address.dimensions;
    const cells = givenCells.map((c) => ({
      ...c,
      elements: address.toCubeOrder(c.elements),
    }));

    // A cube with the Sandboxes dimension (EnableSandboxDimension=true) carries
    // the sandbox in the coordinate itself. Bind a left-out Sandboxes to the
    // target, and refuse a coordinate that names a different one — otherwise a
    // sandbox-mode write could reach Base, or another sandbox, through it.
    const sbPos = sandboxPosition(dimensions);
    if (target !== undefined && sbPos >= 0) {
      for (const c of cells) {
        if (address.sandboxDefaulted) {
          c.elements[sbPos] = target;
        } else if (c.elements[sbPos]!.toLowerCase() !== target.toLowerCase()) {
          throw new TM1Error({
            code: "VALIDATION_ERROR",
            message: `A cell names Sandboxes:${c.elements[sbPos]} but the write targets sandbox "${target}". Nothing was sent.`,
            hint: "Leave the Sandboxes dimension out (it is then bound to `sandbox`), or name the same sandbox in both places.",
          });
        }
      }
    }

    // One probe per distinct hierarchy, not per cell: a write typically
    // reuses the same handful of elements across many coordinates.
    const byHierarchy = new Map<
      string,
      { dimension: string; hierarchy: string; names: Set<string> }
    >();
    for (const c of cells) {
      c.elements.forEach((e, idx) => {
        const ref = memberRef(dimensions[idx]!, e);
        const key = `${ref.dimension}\u0000${ref.hierarchy}`;
        const entry = byHierarchy.get(key) ?? {
          dimension: ref.dimension,
          hierarchy: ref.hierarchy,
          names: new Set<string>(),
        };
        entry.names.add(ref.element);
        byHierarchy.set(key, entry);
      });
    }

    const consolidated: string[] = [];
    for (const { dimension, hierarchy, names } of byHierarchy.values()) {
      try {
        const hits = await tm1Client.elements.consolidatedAmong(
          dimension,
          hierarchy,
          [...names],
        );
        for (const hit of hits) consolidated.push(`${dimension}:${hit}`);
      } catch (e) {
        // Fail closed. A probe that did not answer is not evidence that the
        // coordinates are leaves, and the tool promises every coordinate is
        // checked before anything is sent — so an unanswered probe stops the
        // write instead of reading as "no consolidations found".
        throw new TM1Error({
          code: e instanceof TM1Error ? e.code : "TM1_ERROR",
          message: `Could not check the elements of ${dimension}:${hierarchy} for consolidations: ${e instanceof Error ? e.message : String(e)}. Nothing was sent.`,
          hint: "Verify the dimension and hierarchy names — in `dimensions` and in any qualified element reference — then retry. Use tm1_check_writable_coords to inspect the coordinates first.",
          ...(e instanceof TM1Error && e.httpStatus !== undefined
            ? { httpStatus: e.httpStatus }
            : {}),
        });
      }
    }

    if (consolidated.length > 0) {
      throw new TM1Error({
        code: "VALIDATION_ERROR",
        message: `Consolidated coordinates in this write: ${consolidated.join(", ")}. Nothing was sent.`,
        hint: "Write to N-level (leaf) elements instead — tm1_check_writable_coords reports the level of every coordinate. There is no override: an aggregate is computed from the leaves below it, so load those, or run a TI process via tm1_execute_process.",
      });
    }
    // writeCells throws a TM1Error carrying its own partial-commit accounting
    // (written / failed / notAttempted) + a targeted hint, so we let it
    // propagate to the index.ts Proxy unwrapped — wrapping it here would
    // clobber that hint with a generic one.
    await tm1Client.cells.writeCells(cubeName, dimensions, cells, target);
    return actionResponse({
      success: true,
      cellsWritten: cells.length,
      ...(target !== undefined ? { sandbox: target } : {}),
      ...(address.sandboxDefaulted
        ? { sandboxDefaulted: target ?? address.sandboxDefaulted }
        : {}),
    });
  },
});
