import { z } from "zod";
import type { CellValue, MdxAxis, MdxResult } from "../../types.js";
import type { SandboxDifference } from "../../schemas/sandboxes.js";
import { SandboxCompareSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { cleanSandboxName } from "../../lib/sandbox-policy.js";

type Cell = { coordinates: string[]; value: CellValue };

// Decode every cell's coordinate from its ordinal (axis 0 varies fastest) and
// key it by that coordinate. Keying by coordinate rather than by ordinal keeps
// the comparison right when NON EMPTY gives the two sides different axes.
export function cellsByCoordinate(result: MdxResult): Map<string, Cell> {
  const axes: MdxAxis[] = result.axes;
  const radices = axes.map((a) => a.tuples.length);
  const out = new Map<string, Cell>();
  result.cells.forEach((cell, i) => {
    let ord = i;
    const coordinates = radices.flatMap((n, k) => {
      const idx = ord % n;
      ord = Math.floor(ord / n);
      return axes[k]!.tuples[idx]!.members.map(
        (m) => `${m.hierarchyName}:${m.name}`,
      );
    });
    out.set(JSON.stringify(coordinates), { coordinates, value: cell.value });
  });
  return out;
}

const isEmpty = (v: CellValue | undefined): boolean =>
  v === null || v === undefined || v === 0 || v === "";

export function diffCells(
  base: Map<string, Cell>,
  sandbox: Map<string, Cell>,
): SandboxDifference[] {
  const keys = new Set([...sandbox.keys(), ...base.keys()]);
  const diffs: SandboxDifference[] = [];
  for (const key of keys) {
    const b = base.get(key);
    const s = sandbox.get(key);
    const bv = b?.value ?? null;
    const sv = s?.value ?? null;
    if (isEmpty(bv) && isEmpty(sv)) continue;
    if (bv === sv) continue;
    diffs.push({
      coordinates: (s ?? b)!.coordinates,
      base: bv,
      sandbox: sv,
      ...(typeof bv === "number" || typeof sv === "number"
        ? {
            change:
              (typeof sv === "number" ? sv : 0) -
              (typeof bv === "number" ? bv : 0),
          }
        : {}),
    });
  }
  return diffs;
}

export const registerCompareSandbox = defineTool({
  name: "tm1_compare_sandbox",
  description: [
    "Answer 'what has this sandbox changed?': run the same MDX on base data and in the sandbox and list the cells that differ (base, sandbox, change).",
    "Cells are matched by coordinate, so NON EMPTY queries compare correctly. Refuses a slice larger than maxCells instead of comparing part of it.",
    "Use before tm1_publish_sandbox, or to review what a sandbox-mode session wrote.",
  ],
  annotations: READ_ONLY,
  output: SandboxCompareSchema,
  input: {
    sandboxName: z.string().describe("Sandbox to compare with base data"),
    mdx: z
      .string()
      .describe(
        "MDX selecting the region to compare, e.g. the cube slice that was written",
      ),
    maxCells: z
      .number()
      .int()
      .min(1)
      .max(100000)
      .optional()
      .default(10000)
      .describe("Largest slice compared, per side (default 10000)"),
    maxDifferences: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .optional()
      .default(200)
      .describe("Differences returned at most (default 200)"),
  },
  handler: async (
    { sandboxName, mdx, maxCells, maxDifferences },
    tm1Client,
    extra,
  ) => {
    const sandbox = cleanSandboxName(sandboxName);
    if (sandbox === undefined) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: "Name the sandbox to compare.",
      });
    }
    const opts = { signal: extra?.signal };
    const base = await tm1Client.cells.executeMdx(mdx, maxCells, 0, opts);
    const inSandbox = await tm1Client.cells.executeMdx(
      mdx,
      maxCells,
      0,
      opts,
      sandbox,
    );
    const largest = Math.max(base.totalCellCount, inSandbox.totalCellCount);
    if (largest > maxCells) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: `The MDX selects ${largest} cells; maxCells is ${maxCells}. Nothing was compared.`,
        hint: "Narrow the MDX to the region that was written (NON EMPTY helps), or raise maxCells.",
      });
    }
    const baseCells = cellsByCoordinate(base);
    const sandboxCells = cellsByCoordinate(inSandbox);
    const diffs = diffCells(baseCells, sandboxCells);
    const payload = {
      sandbox,
      cellsCompared: new Set([...baseCells.keys(), ...sandboxCells.keys()])
        .size,
      differences: diffs.length,
      truncated: diffs.length > maxDifferences,
      cells: diffs.slice(0, maxDifferences),
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    };
  },
});
