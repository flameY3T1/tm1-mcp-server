#!/usr/bin/env node
// Codemod for backlog #3 phase B: convert text-return mutation tools to a
// JSON envelope `{ success: true, ...identifyingFields }` so they can publish
// MutationResultSchema as outputSchema (typed clients get structuredContent).
//
// Also strips the trivial `} catch (err) { ... text: \`TM1 error: ...\` }` block
// since the MCP proxy in src/index.ts already routes thrown errors through
// formatTm1ErrorResult.
//
// Per-file transforms are hardcoded — each tool has bespoke identifying
// fields. Run with --apply to write changes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const APPLY = process.argv.includes("--apply");

// Each transform: { file, find, replace } where `find` is the literal block
// to remove (success-return + err-catch wrapper) and `replace` is the new
// success block (no try/catch — proxy handles errors).
const transforms = [
  {
    file: "src/tools/model-building/delete-cube.ts",
    find: `      try {
        await tm1Client.deleteCube(name);
        return { content: [{ type: "text", text: \`Cube "\${name}" deleted.\` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: \`TM1 error: \${(err as Error).message}\` }] };
      }`,
    replace: `      await tm1Client.deleteCube(name);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, cubeName: name }, null, 2),
        }],
      };`,
  },
  {
    file: "src/tools/model-building/unload-cube.ts",
    find: `      try {
        await tm1Client.unloadCube(cubeName);
        return { content: [{ type: "text", text: \`Cube "\${cubeName}" unloaded. Next query will reload it and rebuild the fed-cell index.\` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: \`TM1 error: \${(err as Error).message}\` }] };
      }`,
    replace: `      await tm1Client.unloadCube(cubeName);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, cubeName }, null, 2),
        }],
      };`,
  },
  {
    file: "src/tools/dimension-management/create-dimension.ts",
    find: `      try {
        await tm1Client.createDimension(name);
        return { content: [{ type: "text", text: \`Dimension "\${name}" created with default hierarchy.\` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: \`TM1 error: \${(err as Error).message}\` }] };
      }`,
    replace: `      await tm1Client.createDimension(name);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, dimensionName: name }, null, 2),
        }],
      };`,
  },
  {
    file: "src/tools/dimension-management/create-hierarchy.ts",
    find: `      try {
        await tm1Client.createHierarchy(dimensionName, hierarchyName);
        return { content: [{ type: "text", text: \`Hierarchy "\${hierarchyName}" created in dimension "\${dimensionName}".\` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: \`TM1 error: \${(err as Error).message}\` }] };
      }`,
    replace: `      await tm1Client.createHierarchy(dimensionName, hierarchyName);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, dimensionName, hierarchyName }, null, 2),
        }],
      };`,
  },
  {
    file: "src/tools/dimension-management/delete-hierarchy.ts",
    find: `      try {
        await tm1Client.deleteHierarchy(dimensionName, hierarchyName);
        return { content: [{ type: "text", text: \`Hierarchy "\${hierarchyName}" deleted from dimension "\${dimensionName}".\` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: \`TM1 error: \${(err as Error).message}\` }] };
      }`,
    replace: `      await tm1Client.deleteHierarchy(dimensionName, hierarchyName);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, dimensionName, hierarchyName }, null, 2),
        }],
      };`,
  },
  {
    file: "src/tools/dimension-management/delete-dimension.ts",
    find: `      try {
        await tm1Client.deleteDimension(name);
        return { content: [{ type: "text", text: \`Dimension "\${name}" deleted.\` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: \`TM1 error: \${(err as Error).message}\` }] };
      }`,
    replace: `      await tm1Client.deleteDimension(name);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, dimensionName: name }, null, 2),
        }],
      };`,
  },
];

let modified = 0;
const failed = [];
for (const t of transforms) {
  const full = path.join(root, t.file);
  const src = fs.readFileSync(full, "utf8");
  if (!src.includes(t.find)) {
    failed.push({ file: t.file, reason: "find pattern not present (already converted or drift)" });
    continue;
  }
  const next = src.replace(t.find, t.replace);
  modified++;
  if (APPLY) {
    fs.writeFileSync(full, next);
    console.log(`[apply] ${t.file}`);
  } else {
    console.log(`[dry] ${t.file}`);
  }
}

console.log(`\n${APPLY ? "Applied" : "Would modify"}: ${modified}/${transforms.length}`);
if (failed.length > 0) {
  console.log(`Failed: ${failed.length}`);
  for (const f of failed) console.log(`  ${f.file} — ${f.reason}`);
}
