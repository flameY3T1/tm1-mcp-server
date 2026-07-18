// MCP Resources — read-only data assets exposed via URI. Complements the
// tool surface so IDE clients (Kiro, VSCode Copilot Chat) can:
//   - reference TM1 objects in chat as `#tm1://process/foo/code`
//   - browse a sidebar tree
//   - subscribe to updates without polling
//
// Each resource maps to an existing TM1 service call — same backend logic
// as the get_* tools, different MCP entry point.
import {
  type McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../tm1-client.js";
import { maskCode } from "../lib/mask-secrets.js";
import type { CatalogEntry, ResourceCatalog } from "./list-handler.js";

interface ReadResult {
  [x: string]: unknown;
  contents: Array<{ uri: string; mimeType?: string; text: string }>;
}

function asJsonContent(uri: URL, payload: unknown): ReadResult {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export function registerAllResources(
  server: McpServer,
  tm1: TM1Client,
): ResourceCatalog {
  // Build a parallel catalog as we go so installPaginatedListHandler can
  // override SDK's default ListResourcesRequestSchema with cursor support.
  // registerResource still wires the read callbacks; we just keep our own
  // listing source of truth.
  const entries: CatalogEntry[] = [];

  // ── Static endpoints ────────────────────────────────────────────────
  server.registerResource(
    "server-info",
    "tm1://server/info",
    {
      title: "TM1 Server Info",
      description:
        "TM1 server configuration snapshot: name, version, data directory, timezone, integrated security mode.",
      mimeType: "application/json",
    },
    async (uri) => {
      // Project to the documented identity fields only. getInfo().extra
      // carries the full merged /Configuration body, which can include
      // sensitive settings — resources have no params, so unlike the
      // curated tm1_get_server_info tool there is no place to opt in.
      const info = await tm1.server.getInfo();
      return asJsonContent(uri, {
        serverName: info.serverName,
        productVersion: info.productVersion,
        productEdition: info.productEdition,
        adminHost: info.adminHost,
        dataDirectory: info.dataDirectory,
        timeZoneId: info.timeZoneId,
        integratedSecurityMode: info.integratedSecurityMode,
      });
    },
  );
  entries.push({
    kind: "static",
    resource: {
      uri: "tm1://server/info",
      name: "server-info",
      title: "TM1 Server Info",
      description:
        "TM1 server configuration snapshot: name, version, data directory, timezone, integrated security mode.",
      mimeType: "application/json",
    },
  });

  server.registerResource(
    "server-state",
    "tm1://server/state",
    {
      title: "TM1 Server State",
      description:
        "Health-check snapshot: connection state, version, capability flags, object counts (cubes/dimensions/processes/chores/clients).",
      mimeType: "application/json",
    },
    async (uri) => {
      const [info, cubes, dims, procs, chores, clients] = await Promise.all([
        tm1.server.getInfo(),
        tm1.cubes.list(),
        tm1.dimensions.list(),
        tm1.processes.list(),
        tm1.chores.list(),
        tm1.security.listClients(),
      ]);
      return asJsonContent(uri, {
        connected: tm1.isConnected(),
        server: {
          name: info.serverName,
          productVersion: info.productVersion,
          dataDirectory: info.dataDirectory,
          timeZoneId: info.timeZoneId,
        },
        counts: {
          cubes: cubes.length,
          dimensions: dims.length,
          processes: procs.length,
          chores: chores.length,
          clients: clients.length,
        },
      });
    },
  );
  entries.push({
    kind: "static",
    resource: {
      uri: "tm1://server/state",
      name: "server-state",
      title: "TM1 Server State",
      description:
        "Health-check snapshot: connection state, version, capability flags, object counts (cubes/dimensions/processes/chores/clients).",
      mimeType: "application/json",
    },
  });

  // ── Resource templates ──────────────────────────────────────────────
  // Process source code — `tm1://process/{name}/code`
  server.registerResource(
    "process-code",
    new ResourceTemplate("tm1://process/{name}/code", {
      list: async () => {
        const procs = await tm1.processes.list();
        return {
          resources: procs
            .filter((p) => !p.name.startsWith("}"))
            .map((p) => ({
              name: `process-code-${p.name}`,
              uri: `tm1://process/${encodeURIComponent(p.name)}/code`,
              title: `TI: ${p.name}`,
              description: `Source code (Prolog/Metadata/Data/Epilog) of TI process '${p.name}'.`,
              mimeType: "application/json",
            })),
        };
      },
      complete: {
        name: async (value: string) => {
          const procs = await tm1.processes.list();
          const lower = value.toLowerCase();
          return procs
            .filter((p) => !p.name.startsWith("}") && p.name.toLowerCase().includes(lower))
            .map((p) => p.name)
            .slice(0, 100);
        },
      },
    }),
    {
      title: "TI Process Source Code",
      description:
        "Source code of any TurboIntegrator process by name. URI: tm1://process/{name}/code.",
      mimeType: "application/json",
    },
    async (uri, vars) => {
      const raw = vars.name;
      const name = decodeURIComponent(Array.isArray(raw) ? raw[0]! : raw ?? '');
      const code = await tm1.processes.getCode(name);
      // Hard-mask credential literals unconditionally: resources take no
      // parameters, so unlike tm1_get_process_code there is no maskSecrets
      // opt-out — returning the code verbatim would bypass the tool-path
      // redaction (ODBCOpen passwords, credential assignments).
      return asJsonContent(uri, {
        prolog: maskCode(code.prolog),
        metadata: maskCode(code.metadata),
        data: maskCode(code.data),
        epilog: maskCode(code.epilog),
      });
    },
  );
  entries.push({
    kind: "template",
    templateMetadata: {
      title: "TI Process Source Code",
      description:
        "Source code of any TurboIntegrator process by name. URI: tm1://process/{name}/code.",
      mimeType: "application/json",
    },
    list: async () => {
      const procs = await tm1.processes.list();
      return {
        resources: procs
          .filter((p) => !p.name.startsWith("}"))
          .map((p) => ({
            name: `process-code-${p.name}`,
            uri: `tm1://process/${encodeURIComponent(p.name)}/code`,
            title: `TI: ${p.name}`,
            description: `Source code (Prolog/Metadata/Data/Epilog) of TI process '${p.name}'.`,
            mimeType: "application/json",
          })),
      };
    },
  });

  // Cube rules — `tm1://cube/{name}/rules`
  server.registerResource(
    "cube-rules",
    new ResourceTemplate("tm1://cube/{name}/rules", {
      list: async () => {
        // Filter to cubes that actually carry rules — avoids cluttering
        // the resource tree with rule-less cubes whose body is "".
        const cubes = await tm1.cubes.list({ includeRules: true });
        return {
          resources: cubes
            .filter((c) => !c.name.startsWith("}") && c.hasRules)
            .map((c) => ({
              name: `cube-rules-${c.name}`,
              uri: `tm1://cube/${encodeURIComponent(c.name)}/rules`,
              title: `Rules: ${c.name}`,
              description: `Rules text of cube '${c.name}' (SKIPCHECK + FEEDERS sections).`,
              mimeType: "text/plain",
            })),
        };
      },
      complete: {
        name: async (value: string) => {
          const cubes = await tm1.cubes.list();
          const lower = value.toLowerCase();
          return cubes
            .filter((c) => !c.name.startsWith("}") && c.name.toLowerCase().includes(lower))
            .map((c) => c.name)
            .slice(0, 100);
        },
      },
    }),
    {
      title: "Cube Rules Text",
      description:
        "Rules text of any TM1 cube by name. URI: tm1://cube/{name}/rules. Returns plain text.",
      mimeType: "text/plain",
    },
    async (uri, vars) => {
      const raw = vars.name;
      const name = decodeURIComponent(Array.isArray(raw) ? raw[0]! : raw ?? '');
      const rules = await tm1.cubes.getRules(name);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/plain",
            text: rules.rulesText,
          },
        ],
      };
    },
  );
  entries.push({
    kind: "template",
    templateMetadata: {
      title: "Cube Rules Text",
      description:
        "Rules text of any TM1 cube by name. URI: tm1://cube/{name}/rules. Returns plain text.",
      mimeType: "text/plain",
    },
    list: async () => {
      const cubes = await tm1.cubes.list({ includeRules: true });
      return {
        resources: cubes
          .filter((c) => !c.name.startsWith("}") && c.hasRules)
          .map((c) => ({
            name: `cube-rules-${c.name}`,
            uri: `tm1://cube/${encodeURIComponent(c.name)}/rules`,
            title: `Rules: ${c.name}`,
            description: `Rules text of cube '${c.name}' (SKIPCHECK + FEEDERS sections).`,
            mimeType: "text/plain",
          })),
      };
    },
  });

  return { entries };
}
