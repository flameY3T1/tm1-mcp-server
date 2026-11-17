// File-operation schemas: file-content result and bare filename list item.
import { z } from "zod";

export const FileContentResultSchema = z.object({
  fileName: z.string(),
  totalBytes: z.number().int(),
  // Absent when the file went to writeToFile instead of into the response.
  returnedBytes: z.number().int().optional(),
  truncated: z.boolean().optional(),
  truncationReason: z.string().optional(),
  encoding: z.enum(["text", "base64"]).optional(),
  content: z.string().optional(),
  writtenTo: z.string().optional(),
  sha256: z.string().optional(),
});

// listFiles returns bare strings (file/folder names).
export const FilenameItemSchema = z.string();

// tm1_read_server_file result: lines of a server file read through TI (v11).
export const ServerFileReadResultSchema = z.object({
  path: z.string(),
  lineCount: z.number().int(),
  truncated: z.boolean(),
  encoding: z.enum(["utf-8", "windows-1252"]),
  lines: z.array(z.string()),
});
