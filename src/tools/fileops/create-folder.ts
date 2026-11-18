import { z } from "zod";
import { withToolHint } from "../error-format.js";
import { actionResponse } from "../format.js";
import { IDEMPOTENT_WRITE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { CONTAINER_SCHEMA } from "./container.js";

export const registerCreateFolder = defineTool({
  name: "tm1_create_folder",
  description: [
    "Create a folder in the TM1 server's file storage.",
    "container='applications' creates it in the tree users see under Applications in Architect and PAW (v11 and v12). Use before tm1_upload_file there: a document needs an existing parent folder, and v11 takes no document directly under the root.",
    "container='files' (default) creates it in the data directory TI reads from — v12 only; v11 keeps that container flat and answers UNSUPPORTED_OPERATION.",
    "Creates one level per call; the parent folder must already exist.",
    "A folder that is already there is left as it is and reported with created=false.",
    "Remove an empty folder with tm1_delete_file.",
  ],
  annotations: IDEMPOTENT_WRITE,
  output: MutationResultSchema,
  input: {
    path: z
      .string()
      .min(1)
      .describe(
        "Folder path (e.g. 'Reports' or 'Reports/2026'). Every segment but the last must exist.",
      ),
    ...CONTAINER_SCHEMA,
  },
  handler: async ({ path, container }, tm1Client) => {
    const { created } = await withToolHint(
      tm1Client.files.createFolder(path, container),
      "One level per call: the parent folder must exist, and the name must not be taken by a file. List a level with tm1_list_files and the same container.",
    );
    return actionResponse({ success: true, path, container, created });
  },
});
