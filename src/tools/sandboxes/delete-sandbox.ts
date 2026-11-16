import { z } from "zod";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { actionResponse } from "../format.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { requireManagedSandbox } from "../../lib/sandbox-policy.js";

export const registerDeleteSandbox = defineTool({
  name: "tm1_delete_sandbox",
  description: [
    "Delete a sandbox and every change in it. Base data is not touched.",
    "Irreversible — pass confirm=<sandbox name verbatim>.",
    "With TM1_MODE=sandbox only sandboxes named with TM1_SANDBOX_PREFIX. Related: tm1_discard_sandbox empties a sandbox but keeps it.",
  ],
  annotations: DESTRUCTIVE,
  sandboxScoped: true,
  output: MutationResultSchema,
  input: {
    sandboxName: z.string().describe("Sandbox to delete"),
    ...CONFIRM_SCHEMA,
  },
  handler: async ({ sandboxName, confirm }, tm1Client) => {
    requireConfirm(confirm, sandboxName, "sandbox");
    requireManagedSandbox(tm1Client, sandboxName);
    await tm1Client.sandboxes.delete(sandboxName);
    return actionResponse({ success: true, sandboxName });
  },
});
