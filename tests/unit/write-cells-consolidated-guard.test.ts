// tm1_write_cells refuses a consolidated coordinate before it sends anything.
//
// The reason it pre-checks rather than letting TM1 answer: a chunk holding one
// non-writable cell is refused WHOLE (see cell-service.ts), so a single
// consolidated coordinate silently costs every writable cell that travelled
// with it. The guard turns that into one validation error naming the offender.
import { describe, it, expect, vi } from "vitest";
import { z, type ZodRawShape } from "zod";
import { registerWriteCells } from "../../src/tools/celldata/write-cells.js";
import { ElementService } from "../../src/tm1-client/services/element-service.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";
import type { TM1Client } from "../../src/tm1-client.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function makeFakeServer() {
  let captured: ToolHandler | null = null;
  let parser: z.ZodObject<ZodRawShape> | null = null;
  const server = {
    tool: (
      _name: string,
      _desc: string,
      schema: ZodRawShape,
      handler: ToolHandler,
    ) => {
      parser = z.object(schema);
      captured = handler;
    },
  };
  return {
    server: server as unknown as Parameters<typeof registerWriteCells>[0],
    getHandler: (): ToolHandler => {
      if (!captured || !parser) throw new Error("handler not registered");
      const p = parser;
      const h = captured;
      // Parse through the registered schema rather than passing the object
      // straight in, so the handler sees exactly what the SDK would hand it.
      return (args) => h(p.parse(args));
    },
  };
}

const ELEMENTS_RE =
  /\/api\/v1\/Dimensions\('([^']+)'\)\/Hierarchies\('([^']+)'\)\/Elements\?(.*)$/;

/**
 * @param consolidated element names that answer `Type eq 3`, per "Dim/Hier".
 */
function makeClient(
  consolidated: Record<string, string[]>,
  cubeDims: string[] = ["Region", "Month"],
) {
  const probed: string[] = [];
  const request = async (_method: string, path: string) => {
    const m = ELEMENTS_RE.exec(path);
    if (!m) throw new Error(`unexpected path ${path}`);
    const [, dim, hier, query] = m;
    probed.push(`${dim}/${hier}`);
    const filter = decodeURIComponent(
      /\$filter=([^&]*)/.exec(query)?.[1] ?? "",
    );
    expect(filter.startsWith("Type eq 3 and (")).toBe(true);
    const asked = [...filter.matchAll(/Name eq '((?:[^']|'')*)'/g)].map((x) =>
      x[1].replace(/''/g, "'"),
    );
    const known = consolidated[`${dim}/${hier}`] ?? [];
    return {
      value: asked.filter((n) => known.includes(n)).map((n) => ({ Name: n })),
    };
  };
  type Ctor = ConstructorParameters<typeof ElementService>;
  const elements = new ElementService(
    { request } as unknown as Ctor[0],
    undefined as unknown as Ctor[1],
  );
  const writeCells = vi.fn(async () => undefined);
  return {
    probed,
    writeCells,
    client: {
      elements,
      cells: { writeCells },
      cubes: { getDimensionNames: async () => cubeDims },
    } as unknown as TM1Client,
  };
}

function handlerFor(client: TM1Client): ToolHandler {
  const fake = makeFakeServer();
  registerWriteCells(fake.server, client);
  return fake.getHandler();
}

const CELL = (elements: string[]) => ({ elements, value: 42 });

describe("tm1_write_cells consolidated guard", () => {
  it("refuses the call and sends nothing when a coordinate is consolidated", async () => {
    const { client, writeCells } = makeClient({ "Region/Region": ["Europe"] });
    await expect(
      handlerFor(client)({
        cubeName: "Sales",
        dimensions: ["Region", "Month"],
        cells: [CELL(["Europe", "Jan"]), CELL(["Berlin", "Jan"])],
        confirm: "Sales",
      }),
    ).rejects.toThrow(/Region:Europe/);
    expect(writeCells).not.toHaveBeenCalled();
  });

  it("writes when every coordinate is a leaf", async () => {
    const { client, writeCells } = makeClient({});
    await handlerFor(client)({
      cubeName: "Sales",
      dimensions: ["Region", "Month"],
      cells: [CELL(["Berlin", "Jan"])],
      confirm: "Sales",
    });
    expect(writeCells).toHaveBeenCalledTimes(1);
  });

  it("probes the named hierarchy for a qualified [Dim].[Hier].[Elem] member", async () => {
    const { client, probed } = makeClient({});
    await handlerFor(client)({
      cubeName: "Sales",
      dimensions: ["Region", "Month"],
      cells: [CELL(["[Region].[Alt].[Europe]", "Jan"])],
      confirm: "Sales",
    });
    expect(probed).toContain("Region/Alt");
    expect(probed).not.toContain("Region/Region");
  });

  it("catches a consolidation behind a two-part [Dim].[Elem] member", async () => {
    // The writer passes this form through as a default-hierarchy reference, so
    // the guard has to read it the same way instead of probing the whole
    // bracketed string as an element name.
    const { client, writeCells } = makeClient({ "Region/Region": ["Europe"] });
    await expect(
      handlerFor(client)({
        cubeName: "Sales",
        dimensions: ["Region", "Month"],
        cells: [CELL(["[Region].[Europe]", "Jan"])],
        confirm: "Sales",
      }),
    ).rejects.toThrow(/Region:Europe/);
    expect(writeCells).not.toHaveBeenCalled();
  });

  it("catches a consolidation whose name carries an escaped ]]", async () => {
    const { client, writeCells } = makeClient({ "Region/Region": ["A]B"] });
    await expect(
      handlerFor(client)({
        cubeName: "Sales",
        dimensions: ["Region", "Month"],
        cells: [CELL(["[Region].[Region].[A]]B]", "Jan"])],
        confirm: "Sales",
      }),
    ).rejects.toThrow(/Region:A]B/);
    expect(writeCells).not.toHaveBeenCalled();
  });

  it("sends nothing when the pre-check itself fails", async () => {
    // An unanswered probe is not proof the coordinates are leaves.
    const writeCells = vi.fn(async () => undefined);
    const elements = {
      consolidatedAmong: async () => {
        throw new TM1Error({
          code: TM1ErrorCode.TM1_ERROR,
          message: "boom",
          httpStatus: 400,
        });
      },
    };
    const client = {
      elements,
      cells: { writeCells },
      cubes: { getDimensionNames: async () => ["Region", "Month"] },
    } as unknown as TM1Client;
    await expect(
      handlerFor(client)({
        cubeName: "Sales",
        dimensions: ["Region", "Month"],
        cells: [CELL(["Berlin", "Jan"])],
        confirm: "Sales",
      }),
    ).rejects.toThrow(/Nothing was sent/);
    expect(writeCells).not.toHaveBeenCalled();
  });
});

// TM1 fills a dimension missing from the MDX tuple with its default member
// and writes there without an error, so the address is resolved against the
// cube's own dimension list before anything is sent.
describe("tm1_write_cells address resolution", () => {
  const CUBE = ["Region", "Month", "Measure"];

  it("refuses a dimension list that leaves out a cube dimension", async () => {
    const { client, writeCells } = makeClient({}, CUBE);
    await expect(
      handlerFor(client)({
        cubeName: "Sales",
        dimensions: ["Region", "Month"],
        cells: [CELL(["Berlin", "Jan"])],
        confirm: "Sales",
      }),
    ).rejects.toThrow(/missing: Measure/);
    expect(writeCells).not.toHaveBeenCalled();
  });

  it("refuses unknown and duplicated dimension names", async () => {
    const { client, writeCells } = makeClient({}, CUBE);
    await expect(
      handlerFor(client)({
        cubeName: "Sales",
        dimensions: ["Region", "region", "Version"],
        cells: [CELL(["Berlin", "Berlin", "Actual"])],
        confirm: "Sales",
      }),
    ).rejects.toThrow(/not in the cube: Version; listed twice: region/);
    expect(writeCells).not.toHaveBeenCalled();
  });

  it("accepts any order and sends the elements in cube order", async () => {
    const { client, writeCells } = makeClient({}, CUBE);
    await handlerFor(client)({
      cubeName: "Sales",
      dimensions: ["Measure", "Region", "Month"],
      cells: [CELL(["Amount", "Berlin", "Jan"])],
      confirm: "Sales",
    });
    expect(writeCells).toHaveBeenCalledWith(
      "Sales",
      CUBE,
      [{ elements: ["Berlin", "Jan", "Amount"], value: 42 }],
      undefined,
    );
  });

  it("binds a left-out Sandboxes dimension to Base and says so", async () => {
    const { client, writeCells } = makeClient({}, [...CUBE, "Sandboxes"]);
    const res = (await handlerFor(client)({
      cubeName: "Sales",
      dimensions: CUBE,
      cells: [CELL(["Berlin", "Jan", "Amount"])],
      confirm: "Sales",
    })) as { structuredContent?: Record<string, unknown> };
    expect(writeCells).toHaveBeenCalledWith(
      "Sales",
      [...CUBE, "Sandboxes"],
      [{ elements: ["Berlin", "Jan", "Amount", "Base"], value: 42 }],
      undefined,
    );
    expect(JSON.stringify(res)).toContain('"sandboxDefaulted":"Base"');
  });
});
