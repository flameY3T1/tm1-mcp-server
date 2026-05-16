import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, readdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { join, basename, dirname } from "path";

// R2-20: default knowledge bundle shipped with the package. When
// TM1_KNOWLEDGE_DIR is unset, fall back to the in-package directory rather
// than degrading silently. Resolved relative to this module:
//   src/tools/knowledge/get-knowledge.ts → ../../../knowledge/
//   dist/tools/knowledge/get-knowledge.js → ../../../knowledge/
// Both source and built layouts (and node_modules-installed layouts) share
// the same three-up traversal because tsconfig keeps src↔dist symmetric.
function getBundledKnowledgeDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "knowledge");
}

export function registerGetKnowledge(server: McpServer): void {
  server.tool(
    "tm1_get_knowledge",
    [
      "Fetch TM1 knowledge articles from the local knowledge base (configured via TM1_KNOWLEDGE_DIR env var).",
      "topic='list' returns available topics. topic='index' returns the full topic index with section references.",
      "topic='<name>' returns that article (e.g. 'ti-syntax', 'mdx-patterns', 'tm1-rules').",
      "Use 'search' to filter by keyword — only sections containing the term are returned, saving tokens.",
      "Workflow: call with topic='index' first, identify relevant topics/sections, then fetch with search filter.",
    ].join(" "),
    {
      topic: z.string().describe(
        "Topic to retrieve: 'list' for available topics, 'index' for full INDEX.md, or topic name like 'ti-syntax'."
      ),
      search: z.string().optional().describe(
        "Keyword filter (case-insensitive). Returns only sections containing this term. Greatly reduces token usage."
      ),
    },
    async ({ topic, search }) => {
      // Override > bundled fallback. Bundled bundle ships under <pkg>/knowledge/
      // with ti-syntax, mdx-patterns, tm1-rules, INDEX. Point TM1_KNOWLEDGE_DIR
      // at a custom path to replace it project-wide.
      const envDir = process.env.TM1_KNOWLEDGE_DIR;
      const knowledgeDir = envDir ?? getBundledKnowledgeDir();
      const usingBundle = !envDir;
      if (!existsSync(knowledgeDir)) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: usingBundle
              ? `Bundled knowledge directory missing (expected at ${knowledgeDir}). Reinstall the package or set TM1_KNOWLEDGE_DIR to a valid directory.`
              : `Knowledge directory not found: ${knowledgeDir}`,
          }],
        };
      }

      if (topic === "list") {
        const topics = readdirSync(knowledgeDir)
          .filter(f => f.endsWith(".md"))
          .map(f => basename(f, ".md"))
          .sort();
        return {
          content: [{ type: "text", text: `Available knowledge topics:\n${topics.map(t => `- ${t}`).join("\n")}` }],
        };
      }

      const fileName = topic === "index" ? "INDEX.md" : `${topic}.md`;
      const filePath = join(knowledgeDir, fileName);

      if (!existsSync(filePath)) {
        const available = readdirSync(knowledgeDir)
          .filter(f => f.endsWith(".md"))
          .map(f => basename(f, ".md"))
          .sort()
          .join(", ");
        return {
          isError: true,
          content: [{ type: "text", text: `Topic '${topic}' not found. Available: ${available}` }],
        };
      }

      let content = readFileSync(filePath, "utf-8");

      if (search) {
        const keyword = search.toLowerCase();
        const lines = content.split("\n");
        const sections: string[][] = [];
        let current: string[] = [];

        for (const line of lines) {
          if (/^#{1,4} /.test(line) && current.length > 0) {
            sections.push(current);
            current = [line];
          } else {
            current.push(line);
          }
        }
        if (current.length > 0) sections.push(current);

        const matched = sections.filter(s => s.some(l => l.toLowerCase().includes(keyword)));
        if (matched.length === 0) {
          return {
            content: [{ type: "text", text: `No sections in '${topic}' contain '${search}'.` }],
          };
        }
        content = matched.map(s => s.join("\n")).join("\n\n");
      }

      return {
        content: [{ type: "text", text: content }],
      };
    },
  );
}
