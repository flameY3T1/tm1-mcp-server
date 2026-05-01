import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

interface CoordCheck {
  dimension: string;
  element: string;
  exists: boolean;
  type: "Numeric" | "String" | "Consolidated" | "(missing)";
  isNLevel: boolean;
}

export function registerCheckWritableCoords(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_check_writable_coords",
    "Pre-flight check before CellPutN/CellPutS. Verifies (1) every coord element exists, (2) every element is N-Level (writes to Consolidated elements silent-fail), and (3) whether the target cube has rules that may overlap the coord. Returns per-coord status + a rule-overlap warning. Use before writing cells in a TI process or via tm1_write_cells.",
    {
      cube: z.string().describe("Target cube name"),
      coords: z
        .array(z.string())
        .describe(
          "Element name per dimension, in cube dimension order. Length must match cube.dimensions.length.",
        ),
    },
    async ({ cube, coords }) => {
      try {
        const cubes = await tm1Client.getCubes();
        const cubeMeta = cubes.find((c) => c.name.toLowerCase() === cube.toLowerCase());
        if (!cubeMeta) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: `Cube '${cube}' not found` }) }],
            isError: true,
          };
        }
        const dims = cubeMeta.dimensions;
        if (coords.length !== dims.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `coords length ${coords.length} does not match cube '${cube}' dimensions (${dims.length}: ${dims.join(", ")})`,
                }),
              },
            ],
            isError: true,
          };
        }

        const checks: CoordCheck[] = await Promise.all(
          dims.map(async (dim, idx) => {
            const element = coords[idx];
            try {
              const hier = await tm1Client.getHierarchy(dim, dim);
              const el = hier.elements.find(
                (e) => e.name.toLowerCase() === element.toLowerCase(),
              );
              if (!el) {
                return {
                  dimension: dim,
                  element,
                  exists: false,
                  type: "(missing)" as const,
                  isNLevel: false,
                };
              }
              return {
                dimension: dim,
                element: el.name,
                exists: true,
                type: el.type,
                isNLevel: el.type !== "Consolidated",
              };
            } catch {
              return {
                dimension: dim,
                element,
                exists: false,
                type: "(missing)" as const,
                isNLevel: false,
              };
            }
          }),
        );

        let ruleOverlapWarn: { hasRules: boolean; ruleLines: number; note: string } = {
          hasRules: false,
          ruleLines: 0,
          note: "",
        };
        try {
          const rules = await tm1Client.getCubeRules(cube);
          const ruleText = (rules.rulesText ?? "").trim();
          if (ruleText) {
            ruleOverlapWarn = {
              hasRules: true,
              ruleLines: ruleText.split(/\r?\n/).length,
              note:
                "Cube has rules. CellPutN/S to a coord that the rule computes will be silently overridden by the rule. Inspect the rules manually for LHS pattern overlap with this coord.",
            };
          }
        } catch {
          // No rules or error fetching — leave default.
        }

        const allExist = checks.every((c) => c.exists);
        const allNLevel = checks.every((c) => c.isNLevel);
        const writable = allExist && allNLevel;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  cube,
                  writable,
                  allElementsExist: allExist,
                  allElementsNLevel: allNLevel,
                  coords: checks,
                  ruleOverlapWarn,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const msg =
          error instanceof TM1Error
            ? { code: error.code, message: error.message, httpStatus: error.httpStatus, endpoint: error.endpoint }
            : { error: (error as Error).message ?? String(error) };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(msg) }],
          isError: true,
        };
      }
    },
  );
}
