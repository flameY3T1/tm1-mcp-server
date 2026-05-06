import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, basename } from "path";

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
      const knowledgeDir = process.env.TM1_KNOWLEDGE_DIR;
      if (!knowledgeDir) {
        return {
          isError: true,
          content: [{ type: "text", text: "TM1_KNOWLEDGE_DIR env var not set. Set it to your knowledge directory path (e.g. /home/user/tm1-ai-dev/knowledge)." }],
        };
      }
      if (!existsSync(knowledgeDir)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Knowledge directory not found: ${knowledgeDir}` }],
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
