import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import type { ProcessParameter, ProcessVariable, DataSource } from "../../types.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { parseProFile } from "../../lib/pro-parser.js";

interface TabDiff {
  tab: "prolog" | "metadata" | "data" | "epilog";
  installedLines: number;
  fileLines: number;
  identical: boolean;
}

function tabDiff(name: TabDiff["tab"], installed: string, file: string): TabDiff {
  const norm = (s: string) => s.replace(/\r\n/g, "\n").trimEnd();
  return {
    tab: name,
    installedLines: norm(installed).split("\n").length,
    fileLines: norm(file).split("\n").length,
    identical: norm(installed) === norm(file),
  };
}

function diffParams(installed: ProcessParameter[], file: ProcessParameter[]) {
  const map = (arr: ProcessParameter[]) => new Map(arr.map((p) => [p.name, p]));
  const a = map(installed);
  const b = map(file);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: Array<{ name: string; installed: ProcessParameter; file: ProcessParameter }> = [];
  for (const [name, fp] of b) {
    const ip = a.get(name);
    if (!ip) {
      added.push(name);
    } else if (
      ip.type !== fp.type ||
      String(ip.defaultValue ?? "") !== String(fp.defaultValue ?? "") ||
      (ip.prompt ?? "") !== (fp.prompt ?? "")
    ) {
      changed.push({ name, installed: ip, file: fp });
    }
  }
  for (const name of a.keys()) {
    if (!b.has(name)) removed.push(name);
  }
  return { added, removed, changed };
}

function diffVars(installed: ProcessVariable[], file: ProcessVariable[]) {
  const map = (arr: ProcessVariable[]) => new Map(arr.map((v) => [v.name, v]));
  const a = map(installed);
  const b = map(file);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: Array<{ name: string; installed: ProcessVariable; file: ProcessVariable }> = [];
  for (const [name, fv] of b) {
    const iv = a.get(name);
    if (!iv) added.push(name);
    else if (iv.type !== fv.type || iv.position !== fv.position) {
      changed.push({ name, installed: iv, file: fv });
    }
  }
  for (const name of a.keys()) if (!b.has(name)) removed.push(name);
  return { added, removed, changed };
}

function diffDataSource(installed: DataSource, file: DataSource): { identical: boolean; differences: string[] } {
  const diffs: string[] = [];
  if (installed.type !== file.type) diffs.push(`type: ${installed.type} → ${file.type}`);
  const fields: Array<keyof DataSource> = [
    "dataSourceNameForServer",
    "dataSourceNameForClient",
    "asciiDelimiterChar",
    "asciiQuoteCharacter",
    "asciiDecimalSeparator",
    "asciiThousandSeparator",
    "asciiHeaderRecords",
    "view",
    "subset",
    "userName",
  ];
  for (const f of fields) {
    const a = installed[f];
    const b = file[f];
    if ((a ?? "") !== (b ?? "")) diffs.push(`${String(f)}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  }
  return { identical: diffs.length === 0, differences: diffs };
}

export function registerDiffProcessWithFile(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_diff_process_with_file",
    "Compare an installed TI process on the server against a local .pro file. Returns per-tab identical flags + line counts, parameter diff (added/removed/changed), variable diff, and datasource diff. Use before tm1_import_pro_file to preview what will change.",
    {
      filePath: z.string().optional().describe("Absolute path to the .pro file"),
      content: z.string().optional().describe("Raw .pro file content as string"),
      processName: z.string().optional().describe("Override process name. Default: from .pro 602 line."),
    },
    async ({ filePath, content, processName }) => {
      if (!filePath && !content) {
        throw new TM1Error({
          code: TM1ErrorCode.VALIDATION_ERROR,
          message: "Provide filePath or content",
        });
      }
      let body = content ?? "";
      if (!body && filePath) {
        if (!path.isAbsolute(filePath)) {
          throw new TM1Error({
            code: TM1ErrorCode.VALIDATION_ERROR,
            message: `filePath must be absolute: ${filePath}`,
          });
        }
        body = await fs.readFile(filePath, "utf8");
      }

      const parsed = parseProFile(body);
      const name = processName ?? parsed.name;
      if (!name) {
        throw new TM1Error({
          code: TM1ErrorCode.VALIDATION_ERROR,
          message: "Process name not found in .pro and no override provided",
        });
      }

      const [installedCode, installedParams, installedVars, installedDs] = await Promise.all([
        tm1Client.processes.getCode(name),
        tm1Client.processes.getParameters(name),
        tm1Client.processes.getVariables(name),
        tm1Client.processes.getDataSource(name),
      ]);

      const tabs = [
        tabDiff("prolog", installedCode.prolog, parsed.prolog),
        tabDiff("metadata", installedCode.metadata, parsed.metadata),
        tabDiff("data", installedCode.data, parsed.data),
        tabDiff("epilog", installedCode.epilog, parsed.epilog),
      ];
      const params = diffParams(installedParams, parsed.parameters);
      const variables = diffVars(installedVars, parsed.variables);
      const dataSource = diffDataSource(installedDs, parsed.dataSource);

      const allIdentical =
        tabs.every((t) => t.identical) &&
        params.added.length === 0 && params.removed.length === 0 && params.changed.length === 0 &&
        variables.added.length === 0 && variables.removed.length === 0 && variables.changed.length === 0 &&
        dataSource.identical;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { processName: name, identical: allIdentical, tabs, parameters: params, variables, dataSource },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
