import { z } from "zod";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { actionResponse } from "../format.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";

// Deliberately NOT sandboxScoped: publishing writes base data, which is
// exactly what TM1_MODE=sandbox rules out. The tool is registered in
// readwrite mode only — a sandbox-mode server prepares a change, a person
// (or a readwrite server) decides to publish it.
export const registerPublishSandbox = defineTool({
  name: "tm1_publish_sandbox",
  description: [
    "Publish a sandbox: merge its changes into base data. Overwrites the base values of every changed cell.",
    "Irreversible — pass confirm=<sandbox name verbatim>. Registered only with TM1_MODE=readwrite.",
    "Before: tm1_compare_sandbox to see exactly what will change.",
  ],
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    sandboxName: z.string().describe("Sandbox to publish"),
    ...CONFIRM_SCHEMA,
  },
  handler: async ({ sandboxName, confirm }, tm1Client) => {
    requireConfirm(confirm, sandboxName, "sandbox");
    await tm1Client.sandboxes.publish(sandboxName);
    return actionResponse({ success: true, sandboxName });
  },
});
