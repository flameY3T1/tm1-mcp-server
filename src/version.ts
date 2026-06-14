import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(here, "..", "package.json");
let pkg: { name: string; version: string };
try {
  pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    name: string;
    version: string;
  };
} catch {
  pkg = { name: "tm1-mcp-server", version: "unknown" };
}

export const VERSION = pkg.version;
export const NAME = pkg.name;
