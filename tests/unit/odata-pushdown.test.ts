// Server-side $top/$skip push-down for the list_* tools.
//
// Two invariants carry the weight here, because breaking either produces
// silently wrong output rather than an error:
//
//  R1  $skip without $orderby walks TM1's internal index order, which shifts
//      whenever an object is created or deleted — a page walk then duplicates
//      or drops rows.
//  R2  @odata.count counts rows *after* $filter. If any active filter stayed
//      client-side, `total` counts rows the caller can never reach and
//      `has_more` promises pages that come back empty. Such a request has to
//      fall back to a full scan.
import { describe, it, expect } from "vitest";
import { z, type ZodRawShape } from "zod";
import { registerListCubes } from "../../src/tools/metadata/list-cubes.js";
import { registerListProcesses } from "../../src/tools/metadata/list-processes.js";
import { registerListDimensions } from "../../src/tools/metadata/list-dimensions.js";
import { CubeService } from "../../src/tm1-client/services/cube-service.js";
import { ProcessService } from "../../src/tm1-client/services/process-service.js";
import { DimensionService } from "../../src/tm1-client/services/dimension-service.js";
import type { TM1Client } from "../../src/tm1-client.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

type Registrar = (server: never, client: TM1Client) => void;

/** Register a tool against a stub server and hand back its parsed handler. */
function register(registrar: Registrar, client: TM1Client): ToolHandler {
  // Held in an object rather than two `let`s: TS's control-flow analysis does
  // not track assignments made inside the `tool` callback, so a `let x = null`
  // stays narrowed to `null` and the post-check use collapses to `never`.
  const captured: {
    handler: ToolHandler | null;
    parser: z.ZodObject<ZodRawShape> | null;
  } = { handler: null, parser: null };
  const server = {
    tool: (
      _name: string,
      _desc: string,
      schema: ZodRawShape,
      handler: ToolHandler,
    ) => {
      captured.parser = z.object(schema);
      captured.handler = handler;
    },
  };
  registrar(server as never, client);
  const { handler: h, parser: p } = captured;
  if (!h || !p) throw new Error("handler not registered");
  return (args) => h(p.parse(args) as Record<string, unknown>);
}

/**
 * Fake TM1 that behaves the way the live server did under probing: apply
 * $filter (only predicates we actually emit), then $orderby=Name, then
 * $skip/$top, and report @odata.count for the *filtered* set. An unknown
 * predicate throws rather than being ignored — a silently dropped filter would
 * make a broken push-down look correct.
 */
function fakeCollection(
  names: string[],
  paths: string[],
  opts?: { omitCount?: boolean },
) {
  return async (_method: string, path: string) => {
    paths.push(path);
    let rows = [...names];
    const filter = /\$filter=([^&]*)/.exec(path)?.[1];
    if (filter) {
      for (const predicate of filter.split(" and ")) {
        const control = /^not startswith\(Name,'\}'\)$/.exec(predicate);
        const exact = /^Name eq '(.*)'$/.exec(predicate);
        const hasNot = /^not contains\(tolower\(Name\),'(.*)'\)$/.exec(
          predicate,
        );
        const has = /^contains\(tolower\(Name\),'(.*)'\)$/.exec(predicate);
        if (control) rows = rows.filter((n) => !n.startsWith("}"));
        else if (exact)
          rows = rows.filter((n) => n === exact[1]!.replace(/''/g, "'"));
        else if (hasNot)
          rows = rows.filter((n) => !n.toLowerCase().includes(hasNot[1]!));
        else if (has)
          rows = rows.filter((n) => n.toLowerCase().includes(has[1]!));
        else
          throw new Error(
            `fake server cannot evaluate predicate: ${predicate}`,
          );
      }
    }
    const total = rows.length;
    if (path.includes("$orderby=Name"))
      rows.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const skip = Number(/\$skip=(\d+)/.exec(path)?.[1] ?? 0);
    const top = Number(/\$top=(\d+)/.exec(path)?.[1] ?? rows.length);
    rows = rows.slice(skip, skip + top);
    return {
      ...(path.includes("$count=true") && opts?.omitCount !== true
        ? { "@odata.count": total }
        : {}),
      value: rows.map((Name) => ({ Name, Dimensions: [], Hierarchies: [] })),
    };
  };
}

const cubeClient = (
  names: string[],
  paths: string[],
  opts?: { omitCount?: boolean },
): TM1Client =>
  ({
    cubes: new CubeService({
      request: fakeCollection(names, paths, opts),
    } as never),
  }) as unknown as TM1Client;

const processClient = (names: string[], paths: string[]): TM1Client =>
  ({
    processes: new ProcessService({
      request: fakeCollection(names, paths),
    } as never),
  }) as unknown as TM1Client;

const dimensionClient = (names: string[], paths: string[]): TM1Client =>
  ({
    dimensions: new DimensionService({
      request: fakeCollection(names, paths),
    } as never),
  }) as unknown as TM1Client;

const parse = (res: { content: Array<{ text: string }> }) =>
  JSON.parse(res.content[0]!.text);

const CUBES = ["Delta", "Alpha", "Charlie", "Bravo", "Echo", "}Stats"];

describe("list_* OData push-down", () => {
  describe("tm1_list_cubes", () => {
    it("pushes $orderby=Name + $top + $skip + $count=true in a single request", async () => {
      const paths: string[] = [];
      const page = parse(
        await register(
          registerListCubes as Registrar,
          cubeClient(CUBES, paths),
        )({
          limit: 2,
          offset: 1,
        }),
      );

      expect(paths).toHaveLength(1);
      expect(paths[0]).toContain("$orderby=Name");
      expect(paths[0]).toContain("$top=2");
      expect(paths[0]).toContain("$skip=1");
      expect(paths[0]).toContain("$count=true");
      expect(paths[0]).toContain("$filter=not startswith(Name,'}')");
      expect(page.items.map((c: { name: string }) => c.name)).toEqual([
        "Bravo",
        "Charlie",
      ]);
      expect(page.total).toBe(5);
      expect(page.has_more).toBe(true);
    });

    it("falls back to a full scan when nameRegex keeps the filter client-side", async () => {
      const paths: string[] = [];
      const page = parse(
        await register(
          registerListCubes as Registrar,
          cubeClient(CUBES, paths),
        )({
          limit: 2,
          nameRegex: "^[AB]",
        }),
      );

      // R2: pushing $top here would report total=5 (every non-control cube)
      // while only 2 rows are reachable.
      expect(paths[0]).not.toContain("$top=");
      expect(paths[0]).not.toContain("$count=true");
      expect(page.items.map((c: { name: string }) => c.name)).toEqual([
        "Alpha",
        "Bravo",
      ]);
      expect(page.total).toBe(2);
      expect(page.has_more).toBe(false);
    });

    it("pushes nameExact and nameContains down, preserving their precedence", async () => {
      const exactPaths: string[] = [];
      const exact = parse(
        await register(
          registerListCubes as Registrar,
          cubeClient(CUBES, exactPaths),
        )({
          nameExact: "Delta",
          nameContains: "unused-when-nameExact-set",
        }),
      );
      expect(exactPaths[0]).toContain("Name eq 'Delta'");
      expect(exactPaths[0]).not.toContain("unused-when-nameExact-set");
      expect(exact.items.map((c: { name: string }) => c.name)).toEqual([
        "Delta",
      ]);

      const containsPaths: string[] = [];
      const contains = parse(
        await register(
          registerListCubes as Registrar,
          cubeClient(CUBES, containsPaths),
        )({
          nameContains: "A",
        }),
      );
      expect(containsPaths[0]).toContain("contains(tolower(Name),'a')");
      expect(contains.items.map((c: { name: string }) => c.name)).toEqual([
        "Alpha",
        "Bravo",
        "Charlie",
        "Delta",
      ]);
      expect(contains.total).toBe(4);
    });

    it("bypasses push-down for fetchAll and for limit=0", async () => {
      for (const args of [{ fetchAll: true }, { limit: 0 }]) {
        const paths: string[] = [];
        await register(
          registerListCubes as Registrar,
          cubeClient(CUBES, paths),
        )(args);
        expect(paths[0]).not.toContain("$top=");
      }
    });

    it("re-scans when the server answers without @odata.count", async () => {
      const paths: string[] = [];
      const page = parse(
        await register(
          registerListCubes as Registrar,
          cubeClient(CUBES, paths, { omitCount: true }),
        )({ limit: 2 }),
      );

      // Rather than invent a total, the handler pays for a second unpaged
      // request and slices it locally.
      expect(paths).toHaveLength(2);
      expect(paths[1]).not.toContain("$top=");
      expect(page.items.map((c: { name: string }) => c.name)).toEqual([
        "Alpha",
        "Bravo",
      ]);
      expect(page.total).toBe(5);
    });

    it("orders identically whether the page came from the server or the fallback", async () => {
      const pushed = parse(
        await register(
          registerListCubes as Registrar,
          cubeClient(CUBES, []),
        )({ limit: 5 }),
      );
      const scanned = parse(
        await register(
          registerListCubes as Registrar,
          cubeClient(CUBES, []),
        )({
          limit: 5,
          nameRegex: ".",
        }),
      );
      expect(scanned.items).toEqual(pushed.items);
    });

    it("reports has_more=false on a last page that is exactly `limit` long", async () => {
      const page = parse(
        await register(
          registerListCubes as Registrar,
          cubeClient(CUBES, []),
        )({
          limit: 2,
          offset: 3,
        }),
      );
      // 5 non-control cubes, offset 3, limit 2 → the page is full, yet nothing
      // remains. `count === limit` would wrongly promise another page.
      expect(page.count).toBe(2);
      expect(page.has_more).toBe(false);
      expect(page.next_offset).toBeNull();
    });
  });

  describe("tm1_list_processes", () => {
    const PROCS = ["load.actuals", "load.budget", "zz.archive", "}sys.tidy"];

    it("pushes includeControl, nameContains and nameNotContains into $filter", async () => {
      const paths: string[] = [];
      const page = parse(
        await register(
          registerListProcesses as Registrar,
          processClient(PROCS, paths),
        )({
          limit: 10,
          nameContains: "LOAD",
          nameNotContains: "BUDGET",
        }),
      );

      expect(paths[0]).toContain("$filter=not startswith(Name,'}')");
      expect(paths[0]).toContain("contains(tolower(Name),'load')");
      expect(paths[0]).toContain("not contains(tolower(Name),'budget')");
      expect(paths[0]).toContain("$orderby=Name");
      expect(page.items.map((p: { name: string }) => p.name)).toEqual([
        "load.actuals",
      ]);
      expect(page.total).toBe(1);
    });

    it("falls back to a full scan for nameRegex and for excludePattern", async () => {
      for (const args of [{ nameRegex: "^load" }, { excludePattern: "^zz" }]) {
        const paths: string[] = [];
        await register(
          registerListProcesses as Registrar,
          processClient(PROCS, paths),
        )({
          limit: 2,
          ...args,
        });
        expect(paths[0]).not.toContain("$top=");
        expect(paths[0]).not.toContain("$count=true");
      }
    });
  });

  describe("tm1_list_dimensions", () => {
    const DIMS = ["Region", "Account", "Time", "}Clients"];

    it("pushes the outer /Dimensions window down", async () => {
      const paths: string[] = [];
      const page = parse(
        await register(
          registerListDimensions as Registrar,
          dimensionClient(DIMS, paths),
        )({
          limit: 2,
        }),
      );

      expect(paths[0]).toContain("$orderby=Name");
      expect(paths[0]).toContain("$top=2");
      expect(paths[0]).toContain("$filter=not startswith(Name,'}')");
      expect(page.items.map((d: { name: string }) => d.name)).toEqual([
        "Account",
        "Region",
      ]);
      expect(page.total).toBe(3);
      expect(page.has_more).toBe(true);
    });

    it("falls back to a full scan when changedSince filters client-side", async () => {
      const calls: string[] = [];
      await register(
        registerListDimensions as Registrar,
        {
          dimensions: {
            list: async (opts?: unknown) => {
              calls.push(JSON.stringify(opts ?? {}));
              return [{ name: "Region", hierarchies: ["Region"] }];
            },
            getLastUpdatedMap: async () => new Map<string, string>(),
          },
        } as unknown as TM1Client,
      )({ limit: 2, changedSince: "2026-01-01" });

      // changedSince joins }DimensionProperties client-side, so @odata.count
      // would over-report — the service must be called without a page.
      expect(calls).toHaveLength(1);
      expect(calls[0]).not.toContain("page");
    });
  });
});
