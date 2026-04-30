import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerCompileProcess(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_compile_process",
    "Compile a TI process to validate its syntax without executing it. Returns compile errors with line numbers and procedure (Prolog/Metadata/Data/Epilog) when present.",
    {
      name: z.string().describe("TI process name to compile"),
    },
    async ({ name }) => {
      try {
        const result = await tm1Client.compileProcess(name);
        if (result.success) {
          return { content: [{ type: "text", text: `Process "${name}" compiled successfully (no errors).` }] };
        }
        const lines = result.errors.map((e) => {
          const loc = [e.procedure, e.lineNumber ? `line ${e.lineNumber}` : undefined]
            .filter(Boolean)
            .join(" ");
          return loc ? `[${loc}] ${e.message}` : e.message;
        });
        return {
          isError: true,
          content: [{
            type: "text",
            text: `Compile errors (${result.errors.length}):\n${lines.join("\n")}`,
          }],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
