// Maps tool name → outputSchema raw shape. The McpServer Proxy in index.ts
// injects these into `server.registerTool` and wraps callbacks so the
// JSON-stringified text payload is also surfaced as `structuredContent`.
//
// Phase 1: 12 paginated list_* tools. Adding more tools is a one-line
// addition here plus an item schema in ./schemas/items.ts.
import type { ZodRawShape } from "zod";
import { z } from "zod";
import { pageShapeFor } from "./schemas/common.js";
import {
  ChoreItemSchema,
  ClientItemSchema,
  CubeItemSchema,
  DimensionItemSchema,
  ElementAttributeValueSchema,
  FilenameItemSchema,
  GroupItemSchema,
  ProcessItemSchema,
  SessionItemSchema,
  SubsetItemSchema,
  ThreadItemSchema,
  ViewItemSchema,
} from "./schemas/items.js";

// tm1_list_files prefixes a `path` field on top of the page envelope.
const filePageShape = {
  path: z.string().describe("Path that was listed (echoes the input)"),
  ...pageShapeFor(FilenameItemSchema),
};

export const OUTPUT_SCHEMA_MAP: Record<string, ZodRawShape> = {
  tm1_list_cubes: pageShapeFor(CubeItemSchema),
  tm1_list_dimensions: pageShapeFor(DimensionItemSchema),
  tm1_list_processes: pageShapeFor(ProcessItemSchema),
  tm1_list_chores: pageShapeFor(ChoreItemSchema),
  tm1_list_clients: pageShapeFor(ClientItemSchema),
  tm1_list_groups: pageShapeFor(GroupItemSchema),
  tm1_list_views: pageShapeFor(ViewItemSchema),
  tm1_list_subsets: pageShapeFor(SubsetItemSchema),
  tm1_list_files: filePageShape,
  tm1_list_threads: pageShapeFor(ThreadItemSchema),
  tm1_list_sessions: pageShapeFor(SessionItemSchema),
  tm1_list_element_attributes: pageShapeFor(ElementAttributeValueSchema),
};
