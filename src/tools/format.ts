// Shared response-format helper for list_* tools (G1 from MCP best-practices
// review). Adds a `format: "json"|"markdown"` param so agents get structured
// JSON (default, parsed by Proxy into structuredContent) while humans get a
// readable Markdown table when piped to chat output.
//
// Markdown payload deliberately skips structuredContent — agents that need
// typed data should leave format at the default.
import { z } from "zod";
import type { Page } from "./pagination.js";

export const FORMAT_SCHEMA = {
  format: z
    .enum(["json", "markdown"])
    .optional()
    .default("json")
    .describe(
      "Response format. 'json' (default) returns the structured payload — preferred for programmatic agent use, parsed into structuredContent. 'markdown' returns a human-readable table — use when piping to chat output.",
    ),
};

export type ResponseFormat = "json" | "markdown";

export interface Column<T> {
  header: string;
  get: (row: T) => unknown;
}

function mdEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s =
    typeof v === "string"
      ? v
      : Array.isArray(v)
        ? v.join(", ")
        : typeof v === "object"
          ? JSON.stringify(v)
          : String(v);
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").replace(/\r/g, "");
}

// Render an object as a 2-column key/value Markdown table.
// Nested objects become indented sub-tables; scalars stringify directly.
export function renderKV(obj: Record<string, unknown>, title?: string): string {
  const lines: string[] = [];
  if (title) lines.push(`## ${title}`, "");
  lines.push("| key | value |", "| --- | --- |");
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) {
      lines.push(`| ${k} | _(none)_ |`);
    } else if (Array.isArray(v)) {
      lines.push(`| ${k} | ${mdEscape(v)} |`);
    } else if (typeof v === "object") {
      lines.push(`| **${k}** | _(see below)_ |`);
    } else {
      lines.push(`| ${k} | ${mdEscape(v)} |`);
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      lines.push("", `### ${k}`, "");
      lines.push("| key | value |", "| --- | --- |");
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        lines.push(`| ${k2} | ${mdEscape(v2)} |`);
      }
    }
  }
  return lines.join("\n");
}

export function renderTable<T>(rows: readonly T[], columns: Column<T>[]): string {
  if (rows.length === 0) return "_(no rows)_";
  const headers = columns.map((c) => c.header);
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map(
      (row) => `| ${columns.map((c) => mdEscape(c.get(row))).join(" | ")} |`,
    ),
  ];
  return lines.join("\n");
}

export interface PageRenderOpts<T> {
  title: string;
  columns: Column<T>[];
}

export function renderPage<T>(page: Page<T>, opts: PageRenderOpts<T>): string {
  const meta = `${page.total} total · ${page.count} shown · offset ${page.offset}${
    page.has_more ? ` · next_offset ${page.next_offset}` : ""
  }`;
  const table = renderTable(page.items, opts.columns);
  return `## ${opts.title}\n\n${meta}\n\n${table}`;
}

interface TextResult {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: { [k: string]: unknown };
}

// Page payload as either JSON (default, Proxy → structuredContent) or
// Markdown table (for human display).
//
// In markdown mode we also attach `structuredContent` directly so tools that
// declare `outputSchema` still satisfy the SDK's "outputSchema requires
// structuredContent" validation — agents get typed data and the markdown
// renders for humans.
export function pageResponse<T>(
  page: Page<T>,
  format: ResponseFormat,
  opts: PageRenderOpts<T>,
): TextResult {
  if (format === "markdown") {
    return {
      content: [{ type: "text" as const, text: renderPage(page, opts) }],
      structuredContent: page as unknown as { [k: string]: unknown },
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(page, null, 2) }],
  };
}

// Same as pageResponse but for tools that wrap the page envelope with extra
// top-level fields (e.g. list_files prepends `path`). The wrapper object is
// only used for the JSON path; the Markdown table is rendered from the inner
// page so the metadata line stays consistent.
export function wrappedPageResponse<T>(
  wrapper: object,
  page: Page<T>,
  format: ResponseFormat,
  opts: PageRenderOpts<T>,
): TextResult {
  if (format === "markdown") {
    return {
      content: [{ type: "text" as const, text: renderPage(page, opts) }],
      structuredContent: wrapper as { [k: string]: unknown },
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(wrapper, null, 2) }],
  };
}

// Generic JSON-or-Markdown response for non-paginated payloads.
// Caller supplies a markdown renderer that gets the typed payload.
export function payloadResponse<T>(
  payload: T,
  format: ResponseFormat,
  renderMarkdown: (p: T) => string,
): TextResult {
  if (format === "markdown") {
    return {
      content: [{ type: "text" as const, text: renderMarkdown(payload) }],
      structuredContent: payload as unknown as { [k: string]: unknown },
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}
