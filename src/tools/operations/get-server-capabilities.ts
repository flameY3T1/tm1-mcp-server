import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";

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

export function registerGetServerCapabilities(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_get_server_capabilities",
    [
      "Return key TM1 server capabilities as a flat, typed object.",
      "Reads /Configuration + /ActiveConfiguration via tm1_get_server_info and curates the cfg flags",
      "that drive TI behavior, MDX, rules, MTQ parallelism, job queuing, security, logging, and HTTP.",
      "Use this instead of probing TI hacks (e.g. HierarchyCreate/Destroy) to detect feature support.",
    ].join(" "),
    {},
    async () => {
      const info = await tm1Client.server.getInfo();
      const x = (info.extra ?? {}) as Record<string, unknown>;

      const capabilities = {
        server: {
          name: info.serverName,
          productVersion: info.productVersion,
          dataDirectory: info.dataDirectory,
          integratedSecurityMode: info.integratedSecurityMode,
          timeZoneId: info.timeZoneId,
        },
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
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(capabilities, null, 2) }],
      };
    },
  );
}
