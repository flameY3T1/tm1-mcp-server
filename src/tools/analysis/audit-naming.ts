import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import {
  checkName,
  parseMajorVersion,
  type ObjectKind,
  type TM1MajorVersion,
  type Violation,
} from "../../lib/naming/rules.js";
import { isControlName } from "../../lib/control-name.js";

interface Finding {
  objectKind: ObjectKind;
  objectName: string;
  /** Parent context, e.g. "DimX / HierY" for elements/subsets, "CubeZ" for views. */
  parent?: string;
  violations: Violation[];
}

const SCOPE_VALUES = [
  "cubes",
  "dimensions",
  "hierarchies",
  "elements",
  "processes",
  "processVariables",
  "chores",
  "views",
  "subsets",
] as const;
type Scope = (typeof SCOPE_VALUES)[number];

const SCOPE_DEFAULT: ReadonlyArray<Scope> = [
  "cubes",
  "dimensions",
  "hierarchies",
  "elements",
  "processes",
  "chores",
];

const enc = encodeURIComponent;

interface TruncatedElementGroup {
  dimension: string;
  hierarchy: string;
  elementCount: number;
  scannedCount: number;
}

export function registerAuditNaming(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_audit_naming",
    [
      "Bulk-scan all TM1 objects against IBM Planning Analytics naming conventions",
      "(PA 2.0 + 3.1 naming-conventions doc). Pass/fail per object — only HARD violations",
      "are reported (reserved characters, control prefix, length, element leading +/-, TAB in",
      "v12 element names, invalid process-variable identifiers).",
      "Auto-detects the TM1 major version via /api/v1/Configuration/ProductVersion to apply",
      "v12-only rules (TAB in element names). Default scope covers cubes, dimensions,",
      "hierarchies, elements, processes, and chores — elements are checked across all",
      "dimensions but capped at maxElementsPerDim per (dim, hier) (default 100k, paged in",
      "25k blocks); larger dims are truncated transparently via `elementsTruncated`. Opt in",
      "to 'processVariables', 'views', or 'subsets' explicitly since they drive extra REST",
      "calls or large payloads. Control objects ('}'-prefixed) are excluded by default.",
    ].join(" "),
    {
      scope: z
        .array(z.enum(SCOPE_VALUES))
        .optional()
        .describe(
          "Object kinds to audit. Default: cubes, dimensions, hierarchies, elements, " +
            "processes, chores. Element scan is per (dimension, hierarchy), paginated via " +
            "$top/$skip; oversized hierarchies are truncated at maxElementsPerDim and " +
            "reported in elementsTruncated. 'processVariables' triggers per-process variable " +
            "scans; 'views'/'subsets' do per-cube/per-hier listings.",
        ),
      includeControl: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include control objects ('}'-prefix). Default false."),
      maxFindings: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .optional()
        .default(500)
        .describe("Cap on returned findings (default 500). Summary counters reflect the full scan."),
      versionOverride: z
        .enum(["11", "12"])
        .optional()
        .describe(
          "Override auto-detected TM1 major version. Use '12' to apply v12-only rules (e.g., TAB " +
            "in element names) against a v11 server.",
        ),
      elementsPageSize: z
        .number()
        .int()
        .min(1000)
        .max(100000)
        .optional()
        .default(25000)
        .describe(
          "Element-scan page size for $top/$skip pagination. Bounded to keep each response " +
            "well below the V8 string limit (~512 MB). Default 25000.",
        ),
      maxElementsPerDim: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(100000)
        .describe(
          "Per-(dimension, hierarchy) cap on elements scanned. When total exceeds the cap, " +
            "only the first N elements are checked (paginated via elementsPageSize) and the " +
            "truncation is reported under `elementsTruncated` with both totalCount and " +
            "scannedCount, so the partial scan is transparent. Default 100000. Raise (e.g. " +
            "10_000_000) to scan everything; lower for faster audits on huge models.",
        ),
    },
    async ({
      scope,
      includeControl,
      maxFindings,
      versionOverride,
      elementsPageSize,
      maxElementsPerDim,
    }) => {
      const activeScope: ReadonlyArray<Scope> =
        scope && scope.length > 0 ? scope : SCOPE_DEFAULT;
      const want = (s: Scope) => activeScope.includes(s);

      const serverInfo = await tm1Client.server.getInfo();
      const detectedMajor: TM1MajorVersion = parseMajorVersion(serverInfo.productVersion);
      const major: TM1MajorVersion = versionOverride
        ? (Number(versionOverride) as TM1MajorVersion)
        : detectedMajor;

      const findings: Finding[] = [];
      const scanned: Record<string, number> = {
        cubes: 0,
        dimensions: 0,
        hierarchies: 0,
        elements: 0,
        processes: 0,
        processVariables: 0,
        chores: 0,
        views: 0,
        subsets: 0,
      };

      const addIfInvalid = (name: string, kind: ObjectKind, parent?: string): void => {
        const violations = checkName(name, kind, major);
        if (violations.length === 0) return;
        const f: Finding = { objectKind: kind, objectName: name, violations };
        if (parent !== undefined) f.parent = parent;
        findings.push(f);
      };

      // ── Cubes ──────────────────────────────────────────────────────────
      if (want("cubes")) {
        const cubes = await tm1Client.cubes.list();
        const filtered = includeControl
          ? cubes
          : cubes.filter((c) => !isControlName(c.name));
        scanned.cubes = filtered.length;
        for (const c of filtered) addIfInvalid(c.name, "cube");
      }

      // ── Dimensions + Hierarchies + (later) Elements/Subsets ───────────
      const needDims =
        want("dimensions") || want("hierarchies") || want("elements") || want("subsets");
      let dimensionsForChildren: Array<{ name: string; hierarchies: string[] }> | undefined;
      if (needDims) {
        const dims = await tm1Client.dimensions.list();
        const filtered = includeControl
          ? dims
          : dims.filter((d) => !isControlName(d.name));
        // Always reflect dims we fetched/traversed — even when "dimensions" is
        // not in scope, the hierarchy / element / subset walk visited them, so
        // reporting 0 would understate the scan footprint.
        scanned.dimensions = filtered.length;
        if (want("dimensions")) {
          for (const d of filtered) addIfInvalid(d.name, "dimension");
        }
        if (want("hierarchies")) {
          let hierCount = 0;
          for (const d of filtered) {
            for (const h of d.hierarchies) {
              hierCount++;
              addIfInvalid(h, "hierarchy", d.name);
            }
          }
          scanned.hierarchies = hierCount;
        }
        dimensionsForChildren = filtered.map((d) => ({
          name: d.name,
          hierarchies: d.hierarchies,
        }));
      }

      // ── Elements (per-dim/per-hierarchy, server-side paginated) ────────
      // Single-bulk OData call previously crashed Node on large models
      // ("Cannot create a string longer than 0x1fffffe8 characters") because
      // response.text() buffers the full response body into one V8 string.
      // Probe + page strategy: first page asks for $count=true so we learn the
      // total in one round-trip without hitting the /$count endpoint (TM1 v11
      // returns text/plain there and rejects the Accept: application/json sent
      // by the shared HTTP client). If total > maxElementsPerDim we still scan
      // the first N elements (paginated by elementsPageSize) and report the
      // truncation in `elementsTruncated` — never a silent skip. No single
      // response approaches the V8 string limit thanks to $top.
      const elementsTruncated: TruncatedElementGroup[] = [];
      if (want("elements") && dimensionsForChildren) {
        let elemCount = 0;
        for (const d of dimensionsForChildren) {
          for (const h of d.hierarchies) {
            const basePath =
              `/api/v1/Dimensions('${enc(d.name)}')/Hierarchies('${enc(h)}')` +
              `/Elements?$select=Name&$top=${elementsPageSize}`;
            const firstPage = await tm1Client.request<{
              "@odata.count"?: number;
              value: Array<{ Name: string }>;
            }>("GET", `${basePath}&$skip=0&$count=true`);
            const total = firstPage["@odata.count"] ?? firstPage.value.length;
            const scanLimit = Math.min(total, maxElementsPerDim);

            let scannedHere = 0;
            const firstSliceEnd = Math.min(firstPage.value.length, scanLimit);
            for (let i = 0; i < firstSliceEnd; i++) {
              const e = firstPage.value[i]!;
              elemCount++;
              scannedHere++;
              addIfInvalid(e.Name, "element", `${d.name} / ${h}`);
            }
            let skip = firstPage.value.length;
            let lastPageSize = firstPage.value.length;
            while (lastPageSize === elementsPageSize && scannedHere < scanLimit) {
              const page = await tm1Client.request<{ value: Array<{ Name: string }> }>(
                "GET",
                `${basePath}&$skip=${skip}`,
              );
              const remaining = scanLimit - scannedHere;
              const sliceEnd = Math.min(page.value.length, remaining);
              for (let i = 0; i < sliceEnd; i++) {
                const e = page.value[i]!;
                elemCount++;
                scannedHere++;
                addIfInvalid(e.Name, "element", `${d.name} / ${h}`);
              }
              lastPageSize = page.value.length;
              skip += page.value.length;
            }

            if (total > maxElementsPerDim) {
              elementsTruncated.push({
                dimension: d.name,
                hierarchy: h,
                elementCount: total,
                scannedCount: scannedHere,
              });
            }
          }
        }
        scanned.elements = elemCount;
      }

      // ── Subsets (per dim/hier list) ────────────────────────────────────
      if (want("subsets") && dimensionsForChildren) {
        let count = 0;
        for (const d of dimensionsForChildren) {
          for (const h of d.hierarchies) {
            const subs = await tm1Client.subsets.list(d.name, h);
            for (const s of subs) {
              if (!includeControl && isControlName(s.name)) continue;
              count++;
              addIfInvalid(s.name, "subset", `${d.name} / ${h}`);
            }
          }
        }
        scanned.subsets = count;
      }

      // ── Processes + (optional) variables ───────────────────────────────
      let processNames: string[] = [];
      if (want("processes") || want("processVariables")) {
        const procs = await tm1Client.processes.list();
        processNames = (includeControl ? procs : procs.filter((p) => !isControlName(p.name))).map(
          (p) => p.name,
        );
      }
      if (want("processes")) {
        scanned.processes = processNames.length;
        for (const p of processNames) addIfInvalid(p, "process");
      }
      if (want("processVariables")) {
        let count = 0;
        for (const p of processNames) {
          const vars = await tm1Client.processes.getVariables(p);
          for (const v of vars) {
            count++;
            addIfInvalid(v.name, "processVariable", p);
          }
        }
        scanned.processVariables = count;
      }

      // ── Chores ─────────────────────────────────────────────────────────
      if (want("chores")) {
        const chores = await tm1Client.chores.list();
        const filtered = includeControl
          ? chores
          : chores.filter((c) => !isControlName(c.name));
        scanned.chores = filtered.length;
        for (const c of filtered) addIfInvalid(c.name, "chore");
      }

      // ── Views (per-cube) ───────────────────────────────────────────────
      if (want("views")) {
        const cubes = await tm1Client.cubes.list();
        const filteredCubes = includeControl
          ? cubes
          : cubes.filter((c) => !isControlName(c.name));
        let count = 0;
        for (const c of filteredCubes) {
          const views = await tm1Client.views.list(c.name);
          for (const v of views) {
            if (!includeControl && isControlName(v.name)) continue;
            count++;
            addIfInvalid(v.name, "view", c.name);
          }
        }
        scanned.views = count;
      }

      // ── Aggregate + sort ───────────────────────────────────────────────
      const byKind: Record<string, number> = {};
      const byRule: Record<string, number> = {};
      for (const f of findings) {
        byKind[f.objectKind] = (byKind[f.objectKind] ?? 0) + 1;
        for (const v of f.violations) byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
      }

      findings.sort((a, b) => {
        if (a.objectKind !== b.objectKind) return a.objectKind.localeCompare(b.objectKind);
        return a.objectName.localeCompare(b.objectName);
      });

      const truncated = findings.length > maxFindings;
      const trimmed = findings.slice(0, maxFindings);

      const totalScanned = Object.values(scanned).reduce((a, b) => a + b, 0);
      const status = findings.length === 0 ? "pass" : "fail";

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status,
                productVersion: serverInfo.productVersion,
                detectedMajor,
                appliedMajor: major,
                scope: activeScope,
                includeControl,
                scanned,
                totalScanned,
                invalidCount: findings.length,
                summary: { byKind, byRule },
                truncated,
                findings: trimmed,
                elementsTruncated,
                rulesetSource:
                  "IBM PA naming-conventions (2.0 + 3.1) — hard rules only (server-reserved chars, control prefix, length 256, element leading +/-, TAB in v12 elements, process-var identifier).",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
