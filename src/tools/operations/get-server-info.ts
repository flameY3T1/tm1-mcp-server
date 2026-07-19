import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { FORMAT_SCHEMA, payloadResponse, renderKV } from "../format.js";
import { maskSecretsDeep } from "../../lib/mask-secrets.js";

// Pull a nested key path from the raw merged configuration. Returns undefined if any
// segment is missing — TM1 versions vary in which sections they expose.
function pick(extra: Record<string, unknown>, path: string[]): unknown {
  let node: unknown = extra;
  for (const seg of path) {
    if (node === null || node === undefined || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

export function registerGetServerInfo(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_get_server_info",
    [
      "Return TM1 server identity + curated configuration (TI, Rules, MTQ, JobQueuing, Memory, Logging, HTTP, Security) from /Configuration + /ActiveConfiguration.",
      "Use this instead of probing TI hacks (e.g. HierarchyCreate/Destroy) to detect feature support. Raw merged configuration is preserved under `_raw`.",
    ].join(" "),
    { ...FORMAT_SCHEMA },
    async ({ format }) => {
      const info = await tm1Client.server.getInfo();
      const x = (info.extra ?? {});

      const payload = {
        serverName: info.serverName,
        productVersion: info.productVersion,
        productEdition: info.productEdition,
        adminHost: info.adminHost,
        dataDirectory: info.dataDirectory,
        timeZoneId: info.timeZoneId,
        integratedSecurityMode: info.integratedSecurityMode,
        modelling: {
          enableNewHierarchyCreation: pick(x, ["Modelling", "EnableNewHierarchyCreation"]),
          mdxSelectCalculatedMemberInputs: pick(x, ["Modelling", "MDXSelectCalculatedMemberInputs"]),
          defaultMeasuresDimension: pick(x, ["Modelling", "DefaultMeasuresDimension"]),
          userDefinedCalculations: pick(x, ["Modelling", "UserDefinedCalculations"]),
        },
        ti: {
          maximumTILockObjects: pick(x, ["Modelling", "TI", "MaximumTILockObjects"]),
          enableTIDebugging: pick(x, ["Modelling", "TI", "EnableTIDebugging"]),
          useExcelSerialDate: pick(x, ["Modelling", "TI", "UseExcelSerialDate"]),
        },
        rules: {
          allowSeparateNandCRules: pick(x, ["Modelling", "Rules", "AllowSeparateNandCRules"]),
          automaticallyAddCubeDependencies: pick(x, ["Modelling", "Rules", "AutomaticallyAddCubeDependencies"]),
          rulesOverwriteCellsOnLoad: pick(x, ["Modelling", "Rules", "RulesOverwriteCellsOnLoad"]),
          forceReevaluationOfFeeders: pick(x, ["Modelling", "Rules", "ForceReevaluationOfFeedersForFedCellsOnDataChange"]),
        },
        mtq: {
          useAllThreads: pick(x, ["Performance", "MTQ", "UseAllThreads"]),
          numberOfThreadsToUse: pick(x, ["Performance", "MTQ", "NumberOfThreadsToUse"]),
          singleCellConsolidation: pick(x, ["Performance", "MTQ", "SingleCellConsolidation"]),
          mtqQuery: pick(x, ["Performance", "MTQ", "MTQQuery"]),
          mtFeeders: pick(x, ["Performance", "MTQ", "MTFeeders"]),
          mtFeedersAtStartup: pick(x, ["Performance", "MTQ", "MTFeedersAtStartup"]),
        },
        jobQueuing: {
          enabled: pick(x, ["Performance", "JobQueuing", "Enable"]),
          threadPoolSize: pick(x, ["Performance", "JobQueuing", "ThreadPoolSize"]),
          maxWaitTime: pick(x, ["Performance", "JobQueuing", "MaxWaitTime"]),
        },
        memory: {
          maximumViewSizeMB: pick(x, ["Performance", "Memory", "MaximumViewSizeMB"]),
          maximumUserSandboxSizeMB: pick(x, ["Performance", "Memory", "MaximumUserSandboxSizeMB"]),
          disableSandboxing: pick(x, ["Administration", "DisableSandboxing"]) ?? pick(x, ["DisableSandboxing"]),
        },
        logging: {
          loggingDirectory: pick(x, ["Administration", "DebugLog", "LoggingDirectory"]),
          auditLogEnabled: pick(x, ["Administration", "AuditLog", "Enable"]),
          auditLogMaxKB: pick(x, ["Administration", "AuditLog", "MaxFileSizeKilobytes"]),
          performanceMonitorOn: pick(x, ["Administration", "PerformanceMonitorOn"]),
        },
        http: {
          port: pick(x, ["Access", "HTTP", "Port"]),
          sessionTimeout: pick(x, ["Access", "HTTP", "SessionTimeout"]),
          requestEntityMaxKB: pick(x, ["Access", "HTTP", "RequestEntityMaxSizeInKB"]),
        },
        security: {
          sslEnabled: pick(x, ["Access", "SSL", "Enable"]),
          securityPackageName: pick(x, ["Access", "Authentication", "SecurityPackageName"]),
          integratedSecurityMode: pick(x, ["Access", "Authentication", "IntegratedSecurityMode"]),
          ldapEnabled: pick(x, ["Access", "LDAP", "Enable"]),
        },
        // Mask credential-named values (e.g. Access.LDAP.Password) before the
        // full raw config leaves the server — always on, no opt-out.
        _raw: maskSecretsDeep(x) as Record<string, unknown>,
      };

      return payloadResponse(payload, format, (p) =>
        renderKV(p as unknown as Record<string, unknown>, "Server info"),
      );
    },
  );
}
