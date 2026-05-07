import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import type { Client } from "../../types.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";

const FIELD_KEYS = ["name", "friendlyName", "type", "enabled", "groups", "groupCount"] as const;
type FieldKey = (typeof FIELD_KEYS)[number];

type ProjectedClient = Partial<Client> & { groupCount?: number };

function project(
  clients: Client[],
  fields: FieldKey[] | undefined,
  groupCount: boolean,
): ProjectedClient[] {
  // No projection requested -> keep current shape, optionally swap Groups for groupCount.
  if (!fields || fields.length === 0) {
    if (!groupCount) return clients;
    return clients.map((c) => {
      const { Groups, ...rest } = c;
      return { ...rest, groupCount: Groups?.length ?? 0 };
    });
  }

  const want = new Set<FieldKey>(fields);
  // groupCount=true wins over fields=['groups'] — explicit flag drops the array.
  if (groupCount) {
    want.add("groupCount");
    want.delete("groups");
  }

  return clients.map((c) => {
    const out: ProjectedClient = {};
    if (want.has("name")) out.Name = c.Name;
    if (want.has("friendlyName") && c.FriendlyName !== undefined) out.FriendlyName = c.FriendlyName;
    if (want.has("type") && c.Type !== undefined) out.Type = c.Type;
    if (want.has("enabled") && c.Enabled !== undefined) out.Enabled = c.Enabled;
    if (want.has("groups") && c.Groups !== undefined) out.Groups = c.Groups;
    if (want.has("groupCount")) out.groupCount = c.Groups?.length ?? 0;
    return out;
  });
}

export function registerListClients(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_clients",
    "List TM1 clients (users). Defaults return name, friendly name, enabled state, and full Groups[]. Use fields=['name','type'] for a lean projection or groupCount=true to replace the Groups[] array with an integer count (large savings when groups>>10).",
    {
      ...PAGINATION_SCHEMA,
      fields: z
        .array(z.enum(FIELD_KEYS))
        .optional()
        .describe(
          "Projection: subset of ['name','friendlyName','type','enabled','groups','groupCount']. Omit for full default payload.",
        ),
      groupCount: z
        .boolean()
        .optional()
        .describe(
          "If true, replace the per-client Groups[] array with an integer groupCount. Combine with fields=['name','groupCount'] for the smallest payload.",
        ),
    },
    async ({ limit, offset, fetchAll, fields, groupCount }) => {
      const clients = await tm1Client.listClients();
      const page = paginate(clients, limit, offset, fetchAll);
      const projected = {
        ...page,
        items: project(page.items, fields, groupCount === true),
      };
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(projected, null, 2),
        }],
      };
    },
  );
}
