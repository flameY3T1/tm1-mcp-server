import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { FORMAT_SCHEMA, payloadResponse, renderKV } from "../format.js";

// Pull a nested key path from the raw merged configuration.
function pick(extra: Record<string, unknown>, path: string[]): unknown {
  let node: unknown = extra;
  for (const seg of path) {
    if (node === null || node === undefined || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

function settleCount<T>(res: PromiseSettledResult<T[]>): { count: number | null; error?: string } {
  if (res.status === "fulfilled") return { count: res.value.length };
  return { count: null, error: (res.reason as Error)?.message ?? String(res.reason) };
}

export function registerGetServerState(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_get_server_state",
    [
      "Health-check style snapshot of the TM1 server in one call.",
      "Returns: connection state, version, key capability flags (MTQ, JobQueuing, EnableNewHierarchyCreation),",
      "and object counts for cubes, dimensions, processes, chores, and clients.",
      "All fetches run in parallel; per-bucket failures are reported as count: null with an error message instead of failing the whole call.",
    ].join(" "),
    { ...FORMAT_SCHEMA },
    async ({ format }) => {
      const [infoRes, cubesRes, dimsRes, procsRes, choresRes, clientsRes] = await Promise.allSettled([
        tm1Client.server.getInfo(),
        tm1Client.cubes.list(),
        tm1Client.dimensions.list(),
        tm1Client.processes.list(),
        tm1Client.chores.list(),
        tm1Client.security.listClients(),
      ]);

      const info = infoRes.status === "fulfilled" ? infoRes.value : null;
      const x = (info?.extra ?? {});

      const counts = {
        cubes: settleCount(cubesRes),
        dimensions: settleCount(dimsRes),
        processes: settleCount(procsRes),
        chores: settleCount(choresRes),
        clients: settleCount(clientsRes),
      };

      // OData silently returns empty arrays for objects the user cannot read.
      // Detect implausible count combinations that signal security filtering.
      const securityWarnings: string[] = [];
      const dimCount = counts.dimensions.count;
      if (dimCount !== null && dimCount > 0) {
        if (counts.cubes.count === 0) {
          securityWarnings.push(
            `0 cubes visible despite ${dimCount} dimensions — TM1 security is likely filtering cubes (user lacks READ rights). ` +
            `Use tm1_list_cubes(includeControl: true) to verify, or check group membership with tm1_list_groups.`,
          );
        }
        if (counts.processes.count === 0) {
          securityWarnings.push(
            `0 processes visible despite ${dimCount} dimensions — TM1 security may be filtering processes.`,
          );
        }
      }
      if (counts.clients.count === null && counts.clients.error) {
        securityWarnings.push(
          `Client list failed (${counts.clients.error}) — likely a non-admin session; some object counts may be filtered.`,
        );
      }

      const state = {
        connected: tm1Client.isConnected(),
        server: info
          ? {
              name: info.serverName,
              productVersion: info.productVersion,
              dataDirectory: info.dataDirectory,
              timeZoneId: info.timeZoneId,
            }
          : { error: (infoRes as PromiseRejectedResult).reason?.message ?? String((infoRes as PromiseRejectedResult).reason) },
        capabilities: info
          ? {
              enableNewHierarchyCreation: pick(x, ["Modelling", "EnableNewHierarchyCreation"]),
              allowSeparateNandCRules: pick(x, ["Modelling", "Rules", "AllowSeparateNandCRules"]),
              mtqUseAllThreads: pick(x, ["Performance", "MTQ", "UseAllThreads"]),
              mtqNumberOfThreads: pick(x, ["Performance", "MTQ", "NumberOfThreadsToUse"]),
              jobQueuingEnabled: pick(x, ["Performance", "JobQueuing", "Enable"]),
              jobQueuingThreadPoolSize: pick(x, ["Performance", "JobQueuing", "ThreadPoolSize"]),
              disableSandboxing: pick(x, ["Administration", "DisableSandboxing"]) ?? pick(x, ["DisableSandboxing"]),
              loggingDirectory: pick(x, ["Administration", "DebugLog", "LoggingDirectory"]),
            }
          : null,
        counts,
        ...(securityWarnings.length > 0 && { securityWarnings }),
      };

      return payloadResponse(state, format, (s) =>
        renderKV(s as unknown as Record<string, unknown>, "Server state"),
      );
    },
  );
}
