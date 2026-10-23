import { PAGINATION_SCHEMA, paginate } from "../pagination.js";
import { FORMAT_SCHEMA, pageResponse, columnsOf } from "../format.js";
import { SandboxItemSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { pageShapeFor } from "../schemas/common.js";
import { isManagedSandbox } from "../../lib/sandbox-policy.js";

export const registerListSandboxes = defineTool({
  name: "tm1_list_sandboxes",
  description: [
    "List the signed-in user's sandboxes with their state (active, loaded, queued).",
    "`managed` marks the ones whose name starts with TM1_SANDBOX_PREFIX: the only sandboxes the server may write, discard or delete when TM1_MODE=sandbox.",
    "Related: tm1_create_sandbox, tm1_compare_sandbox.",
  ],
  annotations: READ_ONLY,
  output: pageShapeFor(SandboxItemSchema),
  input: {
    ...PAGINATION_SCHEMA,
    ...FORMAT_SCHEMA,
  },
  handler: async ({ limit, offset, fetchAll, format }, tm1Client) => {
    const sandboxes = (await tm1Client.sandboxes.list()).map((s) => ({
      ...s,
      managed: isManagedSandbox(tm1Client, s.name),
    }));
    const page = paginate(sandboxes, limit, offset, fetchAll);
    type Row = (typeof sandboxes)[number];
    const columns = columnsOf<Row>([
      "name",
      "managed",
      "isActive",
      "isLoaded",
      "isQueued",
    ]);
    return pageResponse(page, format, { title: "Sandboxes", columns });
  },
});
