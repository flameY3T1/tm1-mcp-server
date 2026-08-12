// Shared response-format helper for list_* tools (G1 from MCP best-practices
// review). Adds a `format: "json"|"markdown"` param so agents get structured
// JSON (default, parsed by Proxy into structuredContent) while humans get a
// readable Markdown table when piped to chat output.
//
// The markdown payload travels BOTH ways: as the text block (read by clients
// like Kiro) and as `structuredContent: { markdown }` (read by clients like
// Claude Code, which discard `content` whenever structuredContent is present).
// Shipping it only one way makes format:"markdown" a no-op on one of them.
// Every tool exposing FORMAT_SCHEMA must therefore wrap its outputSchema in
// `markdownCapable()` — see ./schemas/markdown-capable.ts for the why.
import { z } from "zod";
import type { Page } from "./pagination.js";

// Terse by design — see the byte-cost note on PAGINATION_SCHEMA. The enum
// members and the "json" default are emitted structurally by JSON Schema, so
// the description only carries what they cannot: what picking "markdown" does.
export const FORMAT_SCHEMA = {
  format: z
    .enum(["json", "markdown"])
    .optional()
    .default("json")
    .describe("'markdown' = human-readable table."),
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

export function renderTable<T>(
  rows: readonly T[],
  columns: Column<T>[],
): string {
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

// The rendered table goes out twice on purpose: once as the text block, once
// as structuredContent. Which of the two a client reads is not negotiable from
// here — Kiro renders `content` and ignores structuredContent, Claude Code
// does the reverse — so a markdown response that fills only one of them is
// invisible on the other client. The JSON payload is deliberately NOT included
// alongside: a client that reads structuredContent would then be shown the
// JSON it asked not to get, which is exactly the bug this replaces.
export function markdownResult(markdown: string): TextResult {
  return {
    content: [{ type: "text" as const, text: markdown }],
    structuredContent: { markdown },
  };
}

// Page payload as either JSON (default, Proxy → structuredContent) or
// Markdown table (for human display).
export function pageResponse<T>(
  page: Page<T>,
  format: ResponseFormat,
  opts: PageRenderOpts<T>,
): TextResult {
  if (format === "markdown") {
    return markdownResult(renderPage(page, opts));
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(page) }],
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
    return markdownResult(renderPage(page, opts));
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(wrapper) }],
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
    return markdownResult(renderMarkdown(payload));
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

// Action-result helper for non-paginated mutation tools (delete/clear/
// toggle/etc.) that return a flat {success, ...meta} payload. JSON-only;
// no markdown variant since one-liner action results don't benefit from a
// table view. structuredContent is attached so output-schema-map roundtrip
// is satisfied without the Proxy re-parsing the JSON body.
export function actionResponse<T extends object>(payload: T): TextResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload as unknown as { [k: string]: unknown },
  };
}
