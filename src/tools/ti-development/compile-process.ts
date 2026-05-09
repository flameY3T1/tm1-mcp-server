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
      const result = await tm1Client.processes.compile(name);
      const payload = {
        ok: result.success,
        processName: name,
        errorCount: result.errors.length,
        errors: result.errors,
      };
      return {
        isError: !result.success || undefined,
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    },
  );
}
