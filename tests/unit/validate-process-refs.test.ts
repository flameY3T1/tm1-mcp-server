import { describe, it, expect } from "vitest";
import { contractCheckedClient } from "../helpers/service-contract.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { registerValidateProcessRefs } from "../../src/tools/ti-development/validate-process-refs.js";

// Capture the registered handler and drive it with inline .pro content against
// a stubbed object catalogue. Covers the reference-extraction gaps found in
// the 2026-07-04 prod live sweep: DIMIX literal dim refs and arg-2 cube refs
// (CellPutN/CellPutS/CellIncrementN) were not scanned at all, and a quoted
// value in arg 1 of CellPutS was mis-captured as the cube name.
type ToolCb = (
  args: { content?: string; processName?: string; includeControl?: boolean },
  extra: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

function captureHandler(opts: {
  cubes: string[];
  dimensions: string[];
}): ToolCb {
  let cb: ToolCb | undefined;
  const server = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: ToolCb) => {
      cb = handler;
    },
  } as unknown as McpServer;
  const client = contractCheckedClient({
    cubes: {
      list: async () => opts.cubes.map((name) => ({ name })),
    },
    dimensions: {
      list: async () => opts.dimensions.map((name) => ({ name })),
    },
  } as unknown as TM1Client);
  registerValidateProcessRefs(server, client);
  if (!cb) throw new Error("handler was not registered");
  return cb;
}

// Minimal .pro body: only the prolog section (572) is needed for these cases.
function buildPro(prolog: string): string {
  const lines = prolog.split("\n");
  return [`572,${lines.length}`, ...lines, "573,0", ""].join("\r\n");
}

async function run(cb: ToolCb, prolog: string) {
  const result = await cb({ content: buildPro(prolog) }, {});
  return JSON.parse(result.content[0].text);
}

describe("tm1_validate_process_refs reference extraction", () => {
  it("flags a DIMIX reference to a missing dimension (prod-sweep gap)", async () => {
    const cb = captureHandler({ cubes: [], dimensions: ["zzAccounts"] });
    const payload = await run(
      cb,
      "IF(DIMIX('zzSalesItems', vsAccount)=0);\n  itemskip;\nENDIF;",
    );
    expect(payload.dimensionRefsScanned).toBe(1);
    expect(payload.unresolved).toBe(1);
    expect(payload.issues[0].name).toBe("zzSalesItems");
    expect(payload.issues[0].kind).toBe("dimension");
  });

  it("resolves DIMIX against an existing dimension", async () => {
    const cb = captureHandler({ cubes: [], dimensions: ["zzAccounts"] });
    const payload = await run(cb, "nIx = DIMIX('zzAccounts', 'A 1');");
    expect(payload.dimensionRefsScanned).toBe(1);
    expect(payload.unresolved).toBe(0);
  });

  it("extracts the cube from arg 2 of CellIncrementN with a variable value", async () => {
    const cb = captureHandler({ cubes: ["Reporting"], dimensions: [] });
    const payload = await run(
      cb,
      "CellIncrementN(nValue, 'zzSalesPlan', pYear, vMonth, vsAccount);",
    );
    expect(payload.cubeRefsScanned).toBe(1);
    expect(payload.issues[0].name).toBe("zzSalesPlan");
    expect(payload.issues[0].kind).toBe("cube");
  });

  it("does not mis-capture a quoted CellPutS value as the cube name", async () => {
    const cb = captureHandler({ cubes: ["Reporting"], dimensions: [] });
    const payload = await run(
      cb,
      "CellPutS('some text', 'Reporting', 'E1', 'E2');",
    );
    expect(payload.cubeRefsScanned).toBe(1);
    expect(payload.unresolved).toBe(0);
  });

  it("extracts the cube from arg 2 behind a '|'-concat value", async () => {
    const cb = captureHandler({ cubes: [], dimensions: [] });
    const payload = await run(
      cb,
      "CellPutS(sPrefix | '_x', 'MissingCube', 'E1');",
    );
    expect(payload.issues[0].name).toBe("MissingCube");
  });

  it("resolves the cube behind a nested function call in the value arg", async () => {
    const cb = captureHandler({ cubes: [], dimensions: ["SomeDim"] });
    const payload = await run(
      cb,
      "CellPutN(ATTRN('SomeDim', vsEl, 'Faktor') * nScale, 'MissingCube', 'E1', 'E2');",
    );
    expect(payload.cubeRefsScanned).toBe(1);
    expect(payload.issues[0].name).toBe("MissingCube");
    // The nested ATTRN dim ref is scanned by the arg-1 pattern too.
    expect(payload.dimensionRefsScanned).toBe(1);
    expect(payload.unresolved).toBe(1);
  });

  it("resolves multi-line calls and TI doubled-quote escapes", async () => {
    const cb = captureHandler({ cubes: [], dimensions: [] });
    const payload = await run(
      cb,
      "CellPutS(SUBST(vsQuelle, 1, 2),\n  'It''s a Cube',\n  'E1', 'E2');",
    );
    expect(payload.issues[0].name).toBe("It's a Cube");
  });

  it("ignores a non-literal arg 2 without false positives", async () => {
    const cb = captureHandler({ cubes: [], dimensions: [] });
    const payload = await run(cb, "CellPutN(nWert, sZielCube, 'E1');");
    expect(payload.cubeRefsScanned).toBe(0);
    expect(payload.unresolved).toBe(0);
  });

  it("resolves the dimension behind a nested call in AttrPutS", async () => {
    const cb = captureHandler({ cubes: ["Quelle"], dimensions: [] });
    const payload = await run(
      cb,
      "AttrPutS(CellGetS('Quelle', 'a', 'b'), 'MissingDim', vsEl, 'Alias');",
    );
    expect(payload.cubeRefsScanned).toBe(1);
    expect(payload.dimensionRefsScanned).toBe(1);
    expect(payload.issues[0].name).toBe("MissingDim");
    expect(payload.issues[0].kind).toBe("dimension");
  });

  it("resolves an arg-1 variable bound to a single literal (sCube = 'x')", async () => {
    const cb = captureHandler({ cubes: [], dimensions: [] });
    const payload = await run(
      cb,
      "sCube = 'MissingCube';\nnV = CellGetN(sCube, 'E1', 'E2');",
    );
    expect(payload.cubeRefsScanned).toBe(1);
    expect(payload.issues[0].name).toBe("MissingCube");
    expect(payload.issues[0].kind).toBe("cube");
  });

  it("resolves an arg-2 variable bound to a single literal", async () => {
    const cb = captureHandler({ cubes: [], dimensions: [] });
    const payload = await run(
      cb,
      "sZiel = 'MissingCube';\nCellPutN(nX, sZiel, 'E1');",
    );
    expect(payload.cubeRefsScanned).toBe(1);
    expect(payload.issues[0].name).toBe("MissingCube");
  });

  it("resolves DIMIX with a literal-bound variable", async () => {
    const cb = captureHandler({ cubes: [], dimensions: ["zzAccounts"] });
    const payload = await run(
      cb,
      "sDim = 'GoneDim';\nnIx = DIMIX(sDim, 'A 1');",
    );
    expect(payload.dimensionRefsScanned).toBe(1);
    expect(payload.issues[0].name).toBe("GoneDim");
    expect(payload.issues[0].kind).toBe("dimension");
  });

  it("skips a reassigned variable (ambiguous binding stays dynamic)", async () => {
    const cb = captureHandler({ cubes: [], dimensions: [] });
    const payload = await run(
      cb,
      "sCube = 'CubeA';\nsCube = 'CubeB';\nnV = CellGetN(sCube, 'E1');",
    );
    expect(payload.cubeRefsScanned).toBe(0);
    expect(payload.unresolved).toBe(0);
  });

  it("scans ViewZeroOut and CubeClearData cube args", async () => {
    const cb = captureHandler({ cubes: ["Reporting"], dimensions: [] });
    const payload = await run(
      cb,
      "ViewZeroOut('Reporting', 'zap');\nCubeClearData('GoneCube');",
    );
    expect(payload.cubeRefsScanned).toBe(2);
    expect(payload.unresolved).toBe(1);
    expect(payload.issues[0].name).toBe("GoneCube");
  });

  it("does not read the subset name of SubsetCreateByMDX as a cube", async () => {
    const cb = captureHandler({ cubes: ["Sales"], dimensions: ["Region"] });
    const payload = await run(
      cb,
      "SubsetCreateByMDX('zzNorthOnly', '{[Region].Members}');",
    );
    expect(payload.unresolved).toBe(0);
  });

  it("matches names that differ only in case or spaces, as TM1 does", async () => {
    const cb = captureHandler({
      cubes: ["SalesPlan"],
      dimensions: ["Total Year"],
    });
    const payload = await run(
      cb,
      "nV = CellGetN('sales plan', 'a');\nn = DIMIX('TotalYear', 'x');",
    );
    expect(payload.unresolved).toBe(0);
  });

  it("reads '' inside a name as one quote", async () => {
    const cb = captureHandler({
      cubes: ["Owner's Plan"],
      dimensions: ["Owner's Region"],
    });
    const payload = await run(
      cb,
      "n = CellGetN('Owner''s Plan', 'a');\nn = DIMIX('Owner''s Region', 'x');",
    );
    expect(payload.unresolved).toBe(0);
    expect(payload.cubeRefsScanned).toBe(1);

    const missing = await run(cb, "n = CellGetN('Owner''s Budget', 'a');");
    expect(missing.issues[0].name).toBe("Owner's Budget");
  });

  it("skips a first argument that only starts with a literal", async () => {
    const cb = captureHandler({ cubes: [], dimensions: [] });
    const payload = await run(
      cb,
      "s = CellGetS('}ElementAttributes_' | sDim, vEl, 'Alias');\nn = DIMIX('zzPrefix_' | sSuffix, 'x');",
    );
    expect(payload.unresolved).toBe(0);
  });

  it("still checks a literal first argument that ends the call", async () => {
    const cb = captureHandler({ cubes: [], dimensions: [] });
    const payload = await run(cb, "IF(ViewExists('zzGone', 'v') = 1);\nENDIF;");
    expect(payload.issues[0].name).toBe("zzGone");
  });

  it("does not report the object of an existence probe", async () => {
    const cb = captureHandler({ cubes: [], dimensions: [] });
    const payload = await run(
      cb,
      "sTgt = 'zzClone';\nIF(CubeExists(sTgt) = 0);\nENDIF;\nIF(DimensionExists('zzNewDim') = 0);\nENDIF;",
    );
    expect(payload.unresolved).toBe(0);
  });
});
