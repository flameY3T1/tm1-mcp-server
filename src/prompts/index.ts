// MCP Prompts — parameterised prompt templates surfaced as slash-commands
// in MCP-aware IDE clients (Kiro, VSCode Copilot Chat, Claude Desktop).
// Each prompt returns one user message that briefs the LLM with a concrete
// tool sequence, so the agent doesn't have to re-derive the workflow.
//
// Naming convention: snake_case `tm1_<workflow>` to mirror the tool surface.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface GetPromptResult {
  [x: string]: unknown;
  messages: Array<{
    role: "user" | "assistant";
    content: { type: "text"; text: string };
  }>;
}

function userMessage(text: string): GetPromptResult {
  return {
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}

export function registerAllPrompts(server: McpServer): void {
  // ── tm1_diagnose_process ────────────────────────────────────────────
  server.registerPrompt(
    "tm1_diagnose_process",
    {
      title: "Diagnose failed TI process",
      description:
        "Walk-through to root-cause a failed TurboIntegrator process: error logs (with cascade), parameter shape, callgraph dependencies, message log correlation.",
      argsSchema: {
        processName: z
          .string()
          .describe("Name of the failed TI process to diagnose"),
      },
    },
    async ({ processName }) =>
      userMessage(
        [
          `Diagnose why TI process **${processName}** failed. Follow this sequence:`,
          "",
          `1. **Error logs**: call \`tm1_diagnose_process_error(processName="${processName}", includeRelated=true, tail=80)\` — pulls newest logs + cascade siblings (sub-processes failing seconds apart).`,
          `2. **Parameters**: call \`tm1_get_process_parameters(processName="${processName}")\` — verify the call site passed the right shape.`,
          `3. **Source code**: call \`tm1_get_process_code(processName="${processName}")\` to inspect Prolog/Metadata/Data/Epilog.`,
          `4. **Static refs**: call \`tm1_validate_process_refs(processName="${processName}")\` — surfaces unresolved cube/dimension references.`,
          `5. **Callgraph**: call \`tm1_analyze_callgraph(processName="${processName}", summary=true)\` — what does this process call, what calls it.`,
          `6. **Server log**: \`tm1_get_message_log(filter="${processName}", top=50)\` for server-side correlation.`,
          "",
          "Synthesize: which step failed (Prolog/Metadata/Data/Epilog), what parameter or data triggered it, and the minimal fix.",
        ].join("\n"),
      ),
  );

  // ── tm1_audit_cube ──────────────────────────────────────────────────
  server.registerPrompt(
    "tm1_audit_cube",
    {
      title: "Audit a cube",
      description:
        "Comprehensive read-only audit of a TM1 cube: dimensions, rules, feeders, populated cell counts, callgraph dependencies, recent transaction-log activity.",
      argsSchema: {
        cubeName: z.string().describe("Name of the TM1 cube to audit"),
      },
    },
    async ({ cubeName }) =>
      userMessage(
        [
          `Run a read-only audit of cube **${cubeName}**. Report findings.`,
          "",
          `1. **Shape**: \`tm1_list_cubes(nameExact="${cubeName}", includeRules=true)\` — confirm dimensions and rules-presence.`,
          `2. **Rules**: \`tm1_get_cube_rules(cube="${cubeName}")\` — inspect SKIPCHECK + FEEDERS structure. Validate with \`tm1_check_cube_rule\` if anything looks off.`,
          `3. **Stats**: \`tm1_get_cube_stats(cubeName="${cubeName}")\` — memory, populated cells, fed cells, feeder efficiency.`,
          `4. **Object usage**: \`tm1_analyze_object_usage(objectType="cube", objectName="${cubeName}")\` — which TI processes / chores / views reference this cube.`,
          `5. **Recent writes**: \`tm1_get_transaction_log(cubeName="${cubeName}", top=30)\` — what changed lately.`,
          "",
          "Output: 1-paragraph health summary, list of concerns (high feeder count, rules without skipcheck, orphan deps), and concrete next-action suggestions.",
        ].join("\n"),
      ),
  );

  // ── tm1_health_check ────────────────────────────────────────────────
  server.registerPrompt(
    "tm1_health_check",
    {
      title: "TM1 server health check",
      description:
        "Snapshot of TM1 server state: connection, version, capability flags, object counts, active sessions, recent errors.",
    },
    async () =>
      userMessage(
        [
          "Run a TM1 server health check and report a 1-paragraph summary plus a punch-list of concerns.",
          "",
          "1. **State**: `tm1_get_server_state` — connection, version, MTQ/JobQueuing flags, object counts.",
          "2. **Sessions**: `tm1_list_sessions(compact=true)` — named users vs. anonymous count.",
          "3. **Threads**: `tm1_list_threads` — long-running operations, locks.",
          "4. **Recent errors**: `tm1_list_error_logs(top=20)` — newest TI failures.",
          "5. **Server log**: `tm1_get_message_log(top=50)` — recent server-level events.",
          "",
          'Flag: stuck threads (state="Wait" with elapsedTime > 10min), repeated error patterns, capability-flag surprises.',
        ].join("\n"),
      ),
  );

  // ── tm1_rules_review ────────────────────────────────────────────────
  server.registerPrompt(
    "tm1_rules_review",
    {
      title: "Cube rules review",
      description:
        "Code-review a cube's rules text: SKIPCHECK placement, FEEDERS coverage, ratio consolidations (N/C splits), syntax validation.",
      argsSchema: {
        cubeName: z.string().describe("Name of the cube whose rules to review"),
      },
    },
    async ({ cubeName }) =>
      userMessage(
        [
          `Review the rules of cube **${cubeName}**. Code-review style.`,
          "",
          `1. **Read rules**: \`tm1_get_cube_rules(cube="${cubeName}")\` — full rules text.`,
          `2. **Syntax check**: \`tm1_check_cube_rule(cube="${cubeName}", rules=<text from step 1>)\` — surface line-numbered errors before any change.`,
          `3. **Stats correlation**: \`tm1_get_cube_stats(cubeName="${cubeName}")\` — fed-cell-count vs populated-numeric, feeder efficiency.`,
          `4. **Reference impact**: \`tm1_analyze_object_usage(objectType="cube", objectName="${cubeName}")\` — what depends on this cube's calculated cells.`,
          "",
          "Comment on:",
          "- SKIPCHECK at the top, FEEDERS section structure",
          "- ratio measures with explicit N: + C: branches (consolidations should not sum ratios)",
          "- feeder coverage for every rules-fed cell",
          "- AllowSeparateNandCRules expectations (check via tm1_get_server_capabilities)",
          "",
          "Suggest changes as a unified diff.",
        ].join("\n"),
      ),
  );
}
