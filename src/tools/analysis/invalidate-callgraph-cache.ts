import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { invalidateCallgraphCache, getCallgraphCacheStats } from "../../lib/callgraph/tm1-adapter.js";

export function registerInvalidateCallgraphCache(server: McpServer, _tm1Client: TM1Client) {
  server.tool(
    "tm1_invalidate_callgraph_cache",
    "Drop the in-memory ReferenceIndex cache used by tm1_analyze_callgraph / tm1_analyze_object_usage / tm1_analyze_chore_graph. Call this after deploying new processes/rules/chores. The next analysis call will rebuild the index (single bulk fetch).",
    {},
    async () => {
      try {
        const before = getCallgraphCacheStats();
        const { cleared } = invalidateCallgraphCache();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ cleared, entriesBefore: before }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: (error as Error).message ?? String(error),
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
