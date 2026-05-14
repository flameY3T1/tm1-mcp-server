import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";

export function registerResolveDefaultMembers(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_resolve_default_members",
    [
      "Bulk variant of tm1_resolve_default_member — resolves N hierarchies in parallel from a single tool call.",
      "Designed for view-construction workflows where 8+ slicer dimensions previously required dozens of sequential round-trips.",
      "Each result carries its own source/confidence/alternatives so callers can audit per-dimension reliability.",
      "Per-item failures surface as result entries with an `error` field instead of `resolved`; the call itself does not fail unless input is empty/invalid.",
    ].join(" "),
    {
      items: z.array(
        z.object({
          dimensionName: z.string(),
          hierarchyName: z.string().optional(),
        }),
      ).min(1).max(64).describe("List of {dimensionName, hierarchyName?} pairs. Capped at 64 per call to bound parallelism."),
    },
    async ({ items }) => {
      const settled = await Promise.allSettled(
        items.map((it) =>
          tm1Client.dimensions.resolveDefaultMember(it.dimensionName, it.hierarchyName),
        ),
      );
      const results = settled.map((s, i) => {
        if (s.status === "fulfilled") return s.value;
        const err = s.reason;
        const item = items[i];
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof TM1Error ? err.code : TM1ErrorCode.TM1_ERROR;
        return {
          dimension: item.dimensionName,
          hierarchy: item.hierarchyName ?? item.dimensionName,
          error: { code, message },
        };
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ results }, null, 2) }],
      };
    },
  );
}
