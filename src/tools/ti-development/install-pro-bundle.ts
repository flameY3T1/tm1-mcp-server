import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";
import { compileUserRegex } from "../../lib/safe-regex.js";
import { parseProFile } from "../../lib/pro-parser.js";
import { resolveLocalPath } from "../local-file.js";

interface FileResult {
  file: string;
  processName: string | null;
  status: "created" | "updated" | "skipped" | "preflight_failed" | "error";
  error?: string;
  preflightErrors?: Array<{ procedure?: string | undefined; lineNumber?: number | undefined; message: string }>;
}

export function registerInstallProBundle(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_install_pro_bundle",
    "Install all .pro files from a directory in one call. Iterates the directory (non-recursive by default), applies tm1_import_pro_file logic per file, and reports per-file outcome. Stops on first failure unless continueOnError=true. Useful for Bedrock or library deployments.",
    {
      directory: z.string().describe("Absolute host path to directory containing .pro files. Disabled unless TM1_LOCAL_FILE_ROOT is set; the directory must resolve within that root."),
      recursive: z.boolean().optional().default(false).describe("Recurse into subdirectories (default false)"),
      pattern: z.string().optional().describe("Regex (JS) on filename. Default: matches *.pro (case-insensitive)."),
      mode: z
        .enum(["create", "update", "upsert"])
        .optional()
        .default("upsert")
        .describe("Per-file deployment mode (default upsert)"),
      preflight: z.boolean().optional().default(true).describe("Run tm1_check_process_code per file. Default true."),
      continueOnError: z
        .boolean()
        .optional()
        .default(false)
        .describe("Continue installing remaining files after a failure. Default false (stop on first error)."),
      dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe("Parse + preflight only — no create/update calls. Default false."),
    },
    async ({ directory, recursive, pattern, mode, preflight, continueOnError, dryRun }, extra) => {
      // R2-02: emit MCP progress notifications per-file so clients can show
      // a moving progress bar during multi-file deploys. Only fires when the
      // client opted in by passing _meta.progressToken in the tool call;
      // sendNotification is fire-and-forget so a non-progress-aware client
      // can't break the install loop.
      const progressToken = extra?._meta?.progressToken;
      const sendProgress = (progress: number, total: number, message: string): void => {
        if (progressToken === undefined) return;
        void extra
          .sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress, total, message },
          })
          .catch(() => undefined);
      };

      const safeDir = resolveLocalPath(directory, "directory");
      const filenameRe = pattern ? compileUserRegex(pattern, undefined, "pattern") : /\.pro$/i;

      async function collect(dir: string): Promise<string[]> {
        const out: string[] = [];
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (recursive) out.push(...(await collect(full)));
          } else if (e.isFile() && filenameRe.test(e.name)) {
            out.push(full);
          }
        }
        return out;
      }

      const files = (await collect(safeDir)).sort();
      if (files.length === 0) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ directory, filesFound: 0, results: [] }) }],
        };
      }

      const installed = await tm1Client.processes.list();
      const installedNames = new Set(installed.map((p: { name: string }) => p.name));

      const results: FileResult[] = [];
      let stopped = false;
      sendProgress(0, files.length, `starting install of ${files.length} files`);

      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        sendProgress(i, files.length, `processing ${path.basename(file)}`);
        if (stopped) {
          results.push({ file, processName: null, status: "skipped", error: "stopped after earlier failure" });
          continue;
        }
        try {
          const body = await fs.readFile(file, "utf8");
          const parsed = parseProFile(body);
          const processName = parsed.name;
          if (!processName) {
            results.push({ file, processName: null, status: "error", error: "Process name not found in .pro" });
            if (!continueOnError) stopped = true;
            continue;
          }

          if (preflight) {
            const check = await tm1Client.processes.check({
              name: processName,
              prolog: parsed.prolog,
              metadata: parsed.metadata,
              data: parsed.data,
              epilog: parsed.epilog,
              parameters: parsed.parameters,
              variables: parsed.variables,
              dataSource: parsed.dataSource,
            });
            if (!check.success) {
              results.push({ file, processName, status: "preflight_failed", preflightErrors: check.errors });
              if (!continueOnError) stopped = true;
              continue;
            }
          }

          const exists = installedNames.has(processName);
          if (mode === "create" && exists) {
            results.push({ file, processName, status: "error", error: `Already exists; mode=create` });
            if (!continueOnError) stopped = true;
            continue;
          }
          if (mode === "update" && !exists) {
            results.push({ file, processName, status: "error", error: `Does not exist; mode=update` });
            if (!continueOnError) stopped = true;
            continue;
          }

          if (dryRun) {
            results.push({ file, processName, status: exists ? "updated" : "created" });
            continue;
          }

          if (!exists) await tm1Client.processes.create(processName);
          await tm1Client.processes.updateCode(processName, {
            prolog: parsed.prolog,
            metadata: parsed.metadata,
            data: parsed.data,
            epilog: parsed.epilog,
          });
          if (parsed.parameters.length > 0) {
            await tm1Client.processes.updateParameters(processName, parsed.parameters);
          }
          if (parsed.variables.length > 0) {
            await tm1Client.processes.updateVariables(processName, parsed.variables);
          }
          if (parsed.dataSource.type !== "None") {
            await tm1Client.processes.updateDataSource(processName, parsed.dataSource);
          }
          installedNames.add(processName);
          results.push({ file, processName, status: exists ? "updated" : "created" });
        } catch (err) {
          const msg =
            err instanceof TM1Error ? `${err.code}: ${err.message}` : (err as Error).message ?? String(err);
          results.push({ file, processName: null, status: "error", error: msg });
          if (!continueOnError) stopped = true;
        }
      }

      sendProgress(files.length, files.length, "install complete");
      const summary = {
        directory,
        filesFound: files.length,
        dryRun,
        mode,
        counts: {
          created: results.filter((r) => r.status === "created").length,
          updated: results.filter((r) => r.status === "updated").length,
          preflight_failed: results.filter((r) => r.status === "preflight_failed").length,
          error: results.filter((r) => r.status === "error").length,
          skipped: results.filter((r) => r.status === "skipped").length,
        },
        results,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(summary) }] };
    },
  );
}
