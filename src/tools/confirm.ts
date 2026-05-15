// Confirmation guard for destructive tool calls (R2-10 from MCP best-
// practices review). LLMs occasionally fire delete_* / clear_* tools
// without sufficient evidence the action is intended. Requiring the
// caller to repeat the target name as a second argument forces explicit
// intent and makes "auto-approve all" clients safer.
//
// Pattern in a tool registration:
//
//   const CONFIRM_SCHEMA = {
//     confirm: z
//       .string()
//       .describe(
//         "Repeat the target name verbatim to confirm this irreversible action.",
//       ),
//   };
//
//   async ({ name, confirm }) => {
//     requireConfirm(confirm, name, "cube");
//     await tm1Client.cubes.delete(name);
//     ...
//   }
//
// requireConfirm throws TM1Error(VALIDATION_ERROR) on mismatch; the
// Proxy in src/index.ts catches and reformats to the uniform error shape.
import { z } from "zod";
import { TM1Error, TM1ErrorCode } from "../types.js";

export const CONFIRM_SCHEMA = {
  confirm: z
    .string()
    .describe(
      "Safety check: repeat the target identifier verbatim (e.g. cube/dimension/process name) to confirm this irreversible action. Mismatched values reject the call.",
    ),
};

export function requireConfirm(
  provided: string,
  target: string,
  kind: string,
): void {
  if (provided !== target) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: `confirm mismatch — expected ${kind} name "${target}", got "${provided}".`,
      hint: `Re-issue the call with confirm="${target}" verbatim. This safety check prevents accidental destructive operations.`,
    });
  }
}
