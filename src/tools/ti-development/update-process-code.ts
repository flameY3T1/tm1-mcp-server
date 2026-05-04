import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerUpdateProcessCode(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_update_process_code",
    "Update one or more code tabs of a TI process (partial update supported)",
    {
      processName: z.string().describe("Name of the TI process to update"),
      prolog: z.string().optional().describe("New Prolog tab code"),
      metadata: z.string().optional().describe("New Metadata tab code"),
      data: z.string().optional().describe("New Data tab code"),
      epilog: z.string().optional().describe("New Epilog tab code"),
    },
    async ({ processName, prolog, metadata, data, epilog }) => {
      try {
        const code: Record<string, string> = {};
        if (prolog !== undefined) code.prolog = prolog;
        if (metadata !== undefined) code.metadata = metadata;
        if (data !== undefined) code.data = data;
        if (epilog !== undefined) code.epilog = epilog;

        if (Object.keys(code).length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "No code tab provided. Specify at least one of: prolog, metadata, data, epilog.",
              }),
            }],
            isError: true,
          };
        }

        await tm1Client.updateProcessCode(processName, code);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: true, updatedTabs: Object.keys(code) }) }],
        };
      } catch (error) {
        const msg =
          error instanceof TM1Error
            ? { code: error.code, message: error.message, httpStatus: error.httpStatus, endpoint: error.endpoint }
            : { error: String(error) };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(msg) }],
          isError: true,
        };
      }
    },
  );
}
