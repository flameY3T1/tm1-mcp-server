import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { withToolHint } from "../error-format.js";

export function registerCreateProcess(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_create_process",
    [
      "Create a new empty TurboIntegrator process on the TM1 server.",
      "Fails if a process with the same name already exists — for idempotent create-or-replace use tm1_upsert_process instead.",
      "After: tm1_update_process_code to add code, tm1_update_process_parameters for params, tm1_update_process_datasource for ODBC/file sources.",
    ].join(" "),
    {
      name: z.string().describe("Name for the new TI process"),
    },
    async ({ name }) => {
      await withToolHint(
        tm1Client.processes.create(name),
        `Process creation failed. If CONFLICT, the name '${name}' is taken — pick a unique name or call tm1_delete_process first. For atomic create-with-code prefer tm1_upsert_process which bundles create + parameters + variables + code with rollback.`,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, processName: name }) }],
      };
    },
  );
}
