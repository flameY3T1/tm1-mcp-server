#!/usr/bin/env node
// Lint-replacement: fail CI if any code outside the TM1Client facade still calls
// the deprecated flat methods (`tm1Client.getCubes`, `client.executeMdx`, …).
//
// Wired into `npm run verify`. The flat methods themselves still live on
// TM1Client as @deprecated wrappers; this script enforces the migration target
// (use the service API instead) until Phase 10 deletes them in 2.0.
//
// To suppress a known case, refactor it to the service API. There is no opt-out.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

// Only TM1Client.ts itself is allowed to keep flat-method bodies (the
// @deprecated wrappers). Every other consumer must use the service API.
const FACADE_FILE = ["src", "tm1-client.ts"].join(sep);

// Receivers we treat as TM1Client instances. Keep narrow to avoid false
// positives — adding a new test-helper variable means adding it here.
const RECEIVERS = ["tm1Client", "client", "c"];

const FLAT_METHODS = [
  // cubes
  "getCubes", "createCube", "deleteCube", "clearCube", "unloadCube",
  "getCubeRules", "getAllCubeRules", "updateCubeRules", "checkCubeRule",
  "getCubeDimensionNames",
  // dimensions
  "getDimensions", "createDimension", "deleteDimension",
  // hierarchies
  "getHierarchy", "getDescendants", "getAncestors",
  "createHierarchy", "deleteHierarchy",
  // elements
  "createElement", "updateElement", "deleteElement", "moveElement",
  "listElementAttributes", "createElementAttribute", "bulkUpsertElements",
  "getElementAttributeValues", "updateElementAttributeValue",
  // cells
  "getCellValue", "executeMdx", "writeCells",
  // views
  "getView", "getViewDefinition", "listViews", "createMdxView", "deleteView",
  // subsets
  "listSubsets", "getSubset", "createSubset", "updateSubset", "deleteSubset",
  // processes
  "getProcesses", "executeProcess", "getProcessParameters",
  "createProcess", "copyProcess", "fetchProcessesForCallgraph",
  "getAllProcessesCode", "getProcessCode", "updateProcessCode",
  "getProcessDataSource", "updateProcessDataSource",
  "getProcessVariables", "updateProcessVariables",
  "updateProcessParameters", "deleteProcess",
  "compileProcess", "checkProcessCode",
  // chores
  "getChores", "toggleChoreActive", "executeChore",
  "createChore", "updateChore", "deleteChore",
  // security
  "listClients", "getClient", "createClient", "updateClient", "deleteClient",
  "listGroups", "assignClientGroup", "removeClientGroup",
  // server
  "getServerInfo", "getMessageLog", "getTransactionLog",
  "getErrorLogFiles", "getErrorLogContent",
  // monitoring
  "getThreads", "cancelThread", "getSessions",
  // files
  "listFiles", "getFileContent",
];

const PATTERN = new RegExp(
  `\\b(${RECEIVERS.join("|")})\\.(${FLAT_METHODS.join("|")})\\(`,
  "g",
);

// Tools must reach TM1 through a domain service, never the raw transport.
// A tool that calls .request()/.requestRaw()/.requestBinary() directly (e.g.
// hand-rolling OData) bypasses the service layer and reimplements paging,
// escaping and version branches that belong in a service. Enforced only under
// src/tools/** — services and the facade legitimately use the transport.
const TOOLS_DIR = ["src", "tools", ""].join(sep);
const TRANSPORT_RE = /\.(request|requestRaw|requestBinary)\s*\(/g;

function* walkTs(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    const s = statSync(path);
    if (s.isDirectory()) {
      yield* walkTs(path);
    } else if (path.endsWith(".ts")) {
      yield path;
    }
  }
}

// Strip TS comments before scanning so we don't flag references inside JSDoc
// or `//` lines. Replaces comment bodies with same-length whitespace runs so
// line numbers stay accurate.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

const violations = [];
const transportViolations = [];
for (const root of ["src", "tests"]) {
  for (const file of walkTs(root)) {
    if (file === FACADE_FILE) continue;
    const content = stripComments(readFileSync(file, "utf8"));
    PATTERN.lastIndex = 0;
    let m;
    while ((m = PATTERN.exec(content)) !== null) {
      const lineNum = content.slice(0, m.index).split("\n").length;
      violations.push({ file, lineNum, receiver: m[1], method: m[2] });
    }
    if (file.includes(TOOLS_DIR)) {
      TRANSPORT_RE.lastIndex = 0;
      let t;
      while ((t = TRANSPORT_RE.exec(content)) !== null) {
        const lineNum = content.slice(0, t.index).split("\n").length;
        transportViolations.push({ file, lineNum, method: t[1] });
      }
    }
  }
}

if (violations.length > 0 || transportViolations.length > 0) {
  if (violations.length > 0) {
    console.error(`\n✖ Found ${violations.length} use(s) of deprecated flat TM1Client methods.`);
    console.error(`  Migrate to the service API (see docs/ARCHITECTURE.md).\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.lineNum}  ${v.receiver}.${v.method}(...)`);
    }
  }
  if (transportViolations.length > 0) {
    console.error(`\n✖ Found ${transportViolations.length} raw transport call(s) under src/tools/.`);
    console.error(`  Tools must go through a domain service, not .request()/.requestRaw()/.requestBinary().`);
    console.error(`  Add or extend a service under src/tm1-client/services/ (see docs/ARCHITECTURE.md).\n`);
    for (const v of transportViolations) {
      console.error(`  ${v.file}:${v.lineNum}  .${v.method}(...)`);
    }
  }
  console.error("");
  process.exit(1);
}

console.log("✓ no deprecated flat TM1Client method calls outside src/tm1-client.ts");
console.log("✓ no raw transport calls under src/tools/");
