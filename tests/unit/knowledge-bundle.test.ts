import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

// R2-20: verify the bundled knowledge directory ships with the package and
// contains the documented default articles. These files are resolved at
// runtime by get-knowledge.ts via the same three-up traversal.

function repoKnowledgeDir(): string {
  // tests/unit/<this>.ts → repo root → knowledge/
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "knowledge");
}

describe("R2-20: default knowledge bundle", () => {
  const dir = repoKnowledgeDir();

  it("knowledge directory exists at the package root", () => {
    expect(existsSync(dir)).toBe(true);
  });

  it("ships the documented core articles", () => {
    const required = ["INDEX.md", "ti-syntax.md", "mdx-patterns.md", "tm1-rules.md"];
    for (const file of required) {
      expect(existsSync(join(dir, file)), `${file} missing`).toBe(true);
    }
  });

  it("articles are non-empty markdown with at least one heading", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(join(dir, file), "utf-8");
      expect(content.length, `${file} empty`).toBeGreaterThan(100);
      expect(content, `${file} has no top-level heading`).toMatch(/^#\s/m);
    }
  });

  it("INDEX.md references the shipped topic files", () => {
    const index = readFileSync(join(dir, "INDEX.md"), "utf-8");
    expect(index).toMatch(/ti-syntax/);
    expect(index).toMatch(/mdx-patterns/);
    expect(index).toMatch(/tm1-rules/);
  });
});
