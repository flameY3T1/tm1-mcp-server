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
  // ── tm1_orientation ─────────────────────────────────────────────────
  // R2-19: LLM onboarding. Surfaces server topology, naming conventions,
  // pagination/envelope shape, and a workflow→tool map so the agent
  // doesn't have to re-derive these from individual tool descriptions.
  server.registerPrompt(
    "tm1_orientation",
    {
      title: "TM1 MCP server orientation",
      description:
        "Use at the start of a TM1 session to brief yourself on server topology, naming conventions ('}'-prefix control objects), pagination envelope shape, and the recommended tool sequence per workflow (audit, build, debug, deploy). Read before making tool calls in an unfamiliar TM1 environment.",
    },
    async () =>
      userMessage(
        [
          "# TM1 MCP Server Orientation",
          "",
          "## Server topology",
          "TM1 = OLAP database with these primary object types:",
          "- **Cubes** — multidimensional fact tables. Each dimension is an ordered axis.",
          "- **Dimensions** — categorical axes with one or more **Hierarchies** (parent/child trees of **Elements**). Element types: N (numeric leaf), C (consolidation/sum), S (string).",
          "- **Subsets** — named element selections inside a hierarchy. Used as view slicers.",
          "- **Views** — saved MDX query (rows × columns × titles) over a cube.",
          "- **Processes (TI)** — TurboIntegrator scripts. 4 tabs: Prolog → Metadata → Data → Epilog.",
          "- **Chores** — scheduled TI sequences with parameters.",
          "- **Cube Rules** — calculated cell formulas with SKIPCHECK + FEEDERS.",
          "- **Clients / Groups** — security principals.",
          "",
          "## Naming conventions",
          "- Object names starting with `}` are **control objects** (system-internal: }ClientProperties, }StatsByCube, …). All `list_*` tools exclude them by default; set `includeControl=true` to inspect.",
          "- Names are case-sensitive. Use exact match from `list_*` output; never guess casing.",
          "- TI process names allow dots, slashes, spaces — URI-encoded on the wire.",
          "",
          "## Response envelope",
          "List/search tools return:",
          "```json",
          '{ "total": N, "count": K, "offset": O, "has_more": bool, "next_offset": O+K|null, "items": [...] }',
          "```",
          "Override with `fetchAll=true` (entire dataset, beware on large dims) or `format=\"markdown\"` (human-readable table, structuredContent still attached).",
          "",
          "## Workflow → tool map",
          "| Goal | Sequence |",
          "|---|---|",
          "| Inspect a cube | `tm1_list_cubes(nameExact=X)` → `tm1_get_cube_rules` → `tm1_get_cube_stats` |",
          "| Debug failed TI | use the `tm1_diagnose_process` prompt |",
          "| Build new model | `tm1_create_dimension` → `tm1_create_element` (bulk: `tm1_bulk_upsert_elements`) → `tm1_create_cube` |",
          "| Audit cube | use the `tm1_audit_cube` prompt |",
          "| Health check | use the `tm1_health_check` prompt |",
          "| Review rules | use the `tm1_rules_review` prompt |",
          "| Deploy TI bundle | `tm1_diff_process_with_file` (preview) → `tm1_install_pro_bundle` |",
          "| Find dead code | `tm1_find_orphan_dimensions`, `tm1_analyze_object_usage` |",
          "| Pre-write check | `tm1_check_writable_coords` (N-Level + rule-overlap warn) |",
          "",
          "## Safety rules",
          "- Destructive tools (`tm1_delete_cube`, `tm1_delete_dimension`, `tm1_delete_process`, `tm1_clear_cube`) require a `confirm=<name verbatim>` arg as a safety net.",
          "- `tm1_execute_process` and `tm1_execute_chore` are destructive in effect (irreversible cell mutation) even though they are not `delete_*`.",
          "- Cube rules edits: validate first with `tm1_check_cube_rule` before `tm1_set_cube_rules`.",
          "",
          "## When in doubt",
          "Call `tm1_get_server_info` first to check version (v11/v12) and feature flags (MTQ, JobQueuing, AllowSeparateNandCRules).",
        ].join("\n"),
      ),
  );

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
          "- AllowSeparateNandCRules expectations (check via tm1_get_server_info)",
          "",
          "Suggest changes as a unified diff.",
        ].join("\n"),
      ),
  );
}
