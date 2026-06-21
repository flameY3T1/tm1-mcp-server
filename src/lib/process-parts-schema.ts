import { z } from "zod";

// Shared Zod schemas for the deployable parts of a TI process (parameters,
// variables, datasource). Used to validate untrusted input at two boundaries:
//   - tm1_check_process_code tool input (already Zod-validated by the SDK)
//   - parseProcessFromGit, which parses a user-authored {name}.json file
// Keeping one definition prevents the git path from accepting shapes the tool
// path would reject. Field names/shapes mirror ProcessParameter / ProcessVariable
// / DataSource in ../types.ts — keep them in sync.

export const parameterSchema = z.object({
  name: z.string(),
  type: z.enum(["String", "Numeric"]),
  defaultValue: z.union([z.string(), z.number()]),
  prompt: z.string().optional(),
});

export const variableSchema = z.object({
  name: z.string(),
  type: z.enum(["String", "Numeric"]),
  position: z.number(),
  startByte: z.number().optional(),
  endByte: z.number().optional(),
});

export const dataSourceSchema = z.object({
  type: z.enum(["None", "TM1CubeView", "TM1DimensionSubset", "ASCII", "ODBC", "TM1Process"]),
  dataSourceNameForServer: z.string().optional(),
  dataSourceNameForClient: z.string().optional(),
  asciiDelimiterType: z.string().optional(),
  asciiDelimiterChar: z.string().optional(),
  asciiQuoteCharacter: z.string().optional(),
  asciiHeaderRecords: z.number().optional(),
  asciiDecimalSeparator: z.string().optional(),
  asciiThousandSeparator: z.string().optional(),
  usesUnicode: z.boolean().optional(),
  userName: z.string().optional(),
  password: z.string().optional(),
  oDBCConnection: z.string().optional(),
  query: z.string().optional(),
  view: z.string().optional(),
  subset: z.string().optional(),
});
