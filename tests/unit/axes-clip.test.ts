// T7 — axes must be clipped to the returned (capped) cell window so a
// limit=100 read over a 200k-row view does not ship 200k row tuples.
//
// Integrity contract: cells are addressed positionally. Cell ordinal i
// decomposes as idx_k = floor(i / stride_k) mod L_k (stride_0 = 1,
// stride_k = product of lower axis lengths, axis 0 fastest). renderMdxMarkdown
// re-derives coordinates from `offset + i` using the axis tuple counts as
// radices, so clipping an axis length may only ever shrink the SLOWEST
// (highest-index) partially-referenced axis and axes above it — never a
// fully-cycled fast axis whose stride the higher axes decode through.
import { describe, it, expect } from "vitest";
import { z, type ZodRawShape } from "zod";
import type { MdxAxis } from "../../src/types.js";
import { clipAxesToWindow } from "../../src/tm1-client/services/cellset-transform.js";
import { CellService } from "../../src/tm1-client/services/cell-service.js";
import { ViewService } from "../../src/tm1-client/services/view-service.js";
import { registerExecuteMdx } from "../../src/tools/celldata/execute-mdx.js";
import { registerGetView } from "../../src/tools/celldata/get-view.js";
import type { TM1Client } from "../../src/tm1-client.js";

// ── Fixture: 2 cols (C1,C2) × 5 rows (R1..R5) = 10 cells, axis0-fastest. ──────
const ax = (names: string[], hier: string): MdxAxis => ({
  tuples: names.map((n) => ({ members: [{ name: n, hierarchyName: hier }] })),
});
const COLS = ["C1", "C2"];
const ROWS = ["R1", "R2", "R3", "R4", "R5"];
// Cells ordered by ordinal: ord = colIdx + rowIdx*2.
const ALL_CELLS = [
  { Value: 10, FormattedValue: "10" }, // C1,R1
  { Value: 11, FormattedValue: "11" }, // C2,R1
  { Value: 20, FormattedValue: "20" }, // C1,R2
  { Value: 21, FormattedValue: "21" }, // C2,R2
  { Value: 30, FormattedValue: "30" }, // C1,R3
  { Value: 31, FormattedValue: "31" }, // C2,R3
  { Value: 40, FormattedValue: "40" }, // C1,R4
  { Value: 41, FormattedValue: "41" }, // C2,R4
  { Value: 50, FormattedValue: "50" }, // C1,R5
  { Value: 51, FormattedValue: "51" }, // C2,R5
];
const RAW_AXES = [
  { Tuples: COLS.map((n) => ({ Members: [{ Name: n, Hierarchy: { Name: "Cols" } }] })) },
  { Tuples: ROWS.map((n) => ({ Members: [{ Name: n, Hierarchy: { Name: "Rows" } }] })) },
];

// Mock http.request that honours $top/$skip embedded in the Cells expand,
// mirroring TM1's server-side cell pagination. Axes always returned in FULL.
function mockHttp() {
  return {
    request: async (_m: string, path: string) => {
      const top = path.match(/\$top=(\d+)/);
      const skip = path.match(/\$skip=(\d+)/);
      const start = skip ? Number(skip[1]) : 0;
      const end = top ? start + Number(top[1]) : ALL_CELLS.length;
      return { ID: "cs", Cells: ALL_CELLS.slice(start, end), Axes: RAW_AXES };
    },
  } as unknown as ConstructorParameters<typeof CellService>[0];
}

type ToolHandler = (a: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;
function fakeServer() {
  let handler: ToolHandler | null = null;
  let parser: z.ZodObject<ZodRawShape> | null = null;
  const server = {
    tool: (_n: string, _d: string, schema: ZodRawShape, h: ToolHandler) => {
      parser = z.object(schema);
      handler = h;
    },
  };
  return {
    server: server as never,
    run: (a: Record<string, unknown>) => {
      if (!handler || !parser) throw new Error("not registered");
      return handler(parser.parse(a) as Record<string, unknown>);
    },
  };
}

function mdxClient(): TM1Client {
  return { cells: new CellService(mockHttp()) } as unknown as TM1Client;
}
function viewClient(): TM1Client {
  return { views: new ViewService(mockHttp() as never) } as unknown as TM1Client;
}

// ── clipAxesToWindow: the pure integrity core ────────────────────────────────
describe("clipAxesToWindow", () => {
  const axes = () => [ax(COLS, "Cols"), ax(ROWS, "Rows")];

  it("skip=0: shrinks the slow row axis, leaves the fully-cycled fast axis", () => {
    // top=4 → ord 0..3 reference cols {C1,C2} (full) and rows {R1,R2}.
    const r = clipAxesToWindow(axes(), 4, 0);
    expect(r.clipped).toBe(true);
    expect(r.axes[0]!.tuples).toHaveLength(2); // cols untouched
    expect(r.axes[1]!.tuples.map((t) => t.members[0]!.name)).toEqual(["R1", "R2"]);
  });

  it("offset>0: clips to the index-stable prefix [0..maxRef]", () => {
    // skip=4, count=4 → ord 4..7 reference rows {R3,R4}. Prefix keeps R1..R4
    // so decode by absolute index stays valid; only R5 (unreferenced) is dropped.
    const r = clipAxesToWindow(axes(), 4, 4);
    expect(r.clipped).toBe(true);
    expect(r.axes[0]!.tuples).toHaveLength(2); // cols still fully cycled
    expect(r.axes[1]!.tuples.map((t) => t.members[0]!.name)).toEqual(["R1", "R2", "R3", "R4"]);
  });

  it("does NOT clip a partially-referenced FAST axis when a slow axis is active", () => {
    // Pathological wrap: skip=13,count=3 over cols=10,rows=10 → ord 13..15.
    //  idx0 = ord mod 10 = {3,4,5} (partial) but idx1 = 1 (slow axis active).
    // Clipping cols would break `ord mod L0`; the guard must keep cols full.
    const big = [ax([...Array(10)].map((_, i) => `A${i}`), "Ax0"),
                 ax([...Array(10)].map((_, i) => `B${i}`), "Ax1")];
    const r = clipAxesToWindow(big, 3, 13);
    expect(r.axes[0]!.tuples).toHaveLength(10); // fast axis untouched (unsafe to clip)
    expect(r.axes[1]!.tuples).toHaveLength(2);  // slow axis clips to prefix [B0,B1]
    expect(r.clipped).toBe(true);
  });

  it("no clip when the window already spans every referenced tuple", () => {
    const r = clipAxesToWindow(axes(), 10, 0); // full cellset
    expect(r.clipped).toBe(false);
    expect(r.axes[1]!.tuples).toHaveLength(5);
  });

  it("empty inputs are inert", () => {
    expect(clipAxesToWindow([], 4, 0)).toEqual({ axes: [], clipped: false });
    expect(clipAxesToWindow(axes(), 0, 0).clipped).toBe(false);
  });
});

// ── tm1_execute_mdx tool: envelope-level clipping + render integrity ──────────
describe("tm1_execute_mdx axes clipping", () => {
  it("caps axes to the page and flags axes_clipped; total stays full", async () => {
    const { server, run } = fakeServer();
    registerExecuteMdx(server, mdxClient());
    const res = await run({ mdx: "SELECT ...", limit: 4 });
    const env = JSON.parse(res.content[0]!.text);

    expect(env.total).toBe(10); // full cell count preserved
    expect(env.count).toBe(4);
    expect(env.axes[1].tuples).toHaveLength(2); // rows 5 → 2
    expect(env.axes[1].tuples.map((t: { members: { name: string }[] }) => t.members[0].name))
      .toEqual(["R1", "R2"]);
    expect(env.axes_clipped).toBe(true);
  });

  it("small view (fetchAll) is unchanged — full axes, no flag", async () => {
    const { server, run } = fakeServer();
    registerExecuteMdx(server, mdxClient());
    const res = await run({ mdx: "SELECT ...", fetchAll: true });
    const env = JSON.parse(res.content[0]!.text);

    expect(env.axes[1].tuples).toHaveLength(5);
    expect(env.axes_clipped).toBeUndefined();
  });

  it("clipped first page renders a correct grid (integrity)", async () => {
    const { server, run } = fakeServer();
    registerExecuteMdx(server, mdxClient());
    const res = await run({ mdx: "SELECT ...", limit: 4, format: "markdown" });
    const md = res.content[0]!.text;
    expect(md).toContain("| R1 | 10 | 11 |");
    expect(md).toContain("| R2 | 20 | 21 |");
    expect(md).not.toContain("R3");
  });

  it("clipped offset>0 page flat-decodes to the right tuples (integrity)", async () => {
    const { server, run } = fakeServer();
    registerExecuteMdx(server, mdxClient());
    const res = await run({ mdx: "SELECT ...", limit: 4, offset: 4, format: "markdown" });
    const md = res.content[0]!.text;
    // ord 4..7 → C1/R3, C2/R3, C1/R4, C2/R4.
    expect(md).toContain("| C1 | R3 | 30 |");
    expect(md).toContain("| C2 | R3 | 31 |");
    expect(md).toContain("| C1 | R4 | 40 |");
    expect(md).toContain("| C2 | R4 | 41 |");
    expect(md).not.toContain("R5");
  });
});

// ── tm1_get_view tool: same clipping over a named view ───────────────────────
describe("tm1_get_view axes clipping", () => {
  it("caps axes to the page and flags axes_clipped; total stays full", async () => {
    const { server, run } = fakeServer();
    registerGetView(server, viewClient());
    const res = await run({ cubeName: "C", viewName: "V", limit: 4 });
    const env = JSON.parse(res.content[0]!.text);

    expect(env.total).toBe(10);
    expect(env.axes[1].tuples).toHaveLength(2);
    expect(env.axes_clipped).toBe(true);
  });

  it("fetchAll keeps full axes and omits the flag", async () => {
    const { server, run } = fakeServer();
    registerGetView(server, viewClient());
    const res = await run({ cubeName: "C", viewName: "V", fetchAll: true });
    const env = JSON.parse(res.content[0]!.text);

    expect(env.axes[1].tuples).toHaveLength(5);
    expect(env.axes_clipped).toBeUndefined();
  });
});
