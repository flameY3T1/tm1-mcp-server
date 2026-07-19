// File-operation schemas: file-content result and bare filename list item.
import { z } from "zod";

export const FileContentResultSchema = z.object({
  fileName: z.string(),
  totalBytes: z.number().int(),
  returnedBytes: z.number().int(),
  truncated: z.boolean(),
  truncationReason: z.string().optional(),
  content: z.string(),
});

// listFiles returns bare strings (file/folder names).
export const FilenameItemSchema = z.string();
