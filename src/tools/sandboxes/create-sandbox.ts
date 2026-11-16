import { z } from "zod";
import { actionResponse } from "../format.js";
import { WRITE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import {
  cleanSandboxName,
  requireManagedSandbox,
} from "../../lib/sandbox-policy.js";

export const registerCreateSandbox = defineTool({
  name: "tm1_create_sandbox",
  description: [
    "Create a sandbox: a private copy-on-write layer over base data for what-if writes. Base data is not touched.",
    "With TM1_MODE=sandbox the name must start with TM1_SANDBOX_PREFIX (default 'mcp-').",
    "After: tm1_write_cells with sandbox=<name>, then tm1_compare_sandbox to review the change.",
  ],
  annotations: WRITE,
  sandboxScoped: true,
  output: MutationResultSchema,
  input: {
    sandboxName: z.string().describe("Name of the new sandbox"),
  },
  handler: async ({ sandboxName }, tm1Client) => {
    const name = cleanSandboxName(sandboxName);
    if (name === undefined) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: "A sandbox needs a name.",
      });
    }
    requireManagedSandbox(tm1Client, name);
    await tm1Client.sandboxes.create(name);
    return actionResponse({ success: true, sandboxName: name });
  },
});
