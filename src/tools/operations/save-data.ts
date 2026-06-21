import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { withToolHint } from "../error-format.js";

export function registerSaveData(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_save_data",
    [
      "Persist in-memory cube data to disk: SaveDataAll (all cubes) or CubeSaveData when `cube` is given.",
      "Run after write sessions (tm1_write_cells, TI loads) — unsaved changes are lost on server crash.",
      "Persists in-memory data to disk only; it does not clear or truncate the transaction log.",
      "v11 only — v12 removed SaveDataAll/CubeSaveData (cloud engine persists automatically).",
      "Executes as an unbound TI process via ExecuteProcessWithReturn; no process object is created on the server.",
    ].join(" "),
    {
      cube: z
        .string()
        .optional()
        .describe("Save only this cube (CubeSaveData). Omit to save all cubes (SaveDataAll)."),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(3600000)
        .optional()
        .describe("Override the default request timeout (ms, 1000–3600000). SaveDataAll on large models can take minutes."),
    },
    async ({ cube, timeoutMs }, extra) => {
      const result = await withToolHint(
        tm1Client.processes.saveData(cube, {
          signal: extra?.signal,
          ...(timeoutMs ? { timeoutMs } : {}),
        }),
        "SaveData failed. On v12 this tool is unsupported (SaveDataAll removed). Check tm1_get_server_info for productVersion; for a single cube verify the name via tm1_list_cubes.",
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ...result, scope: cube ?? "all" }, null, 2),
          },
        ],
        // A failed SaveData is a data-persistence failure (in-memory data not
        // written to disk) — surface it as an MCP error, not a success payload
        // carrying success:false, so the caller can't silently miss data loss.
        ...(result.success === false ? { isError: true as const } : {}),
      };
    },
  );
}
