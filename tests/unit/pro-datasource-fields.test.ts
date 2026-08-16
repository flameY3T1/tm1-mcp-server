import { describe, it, expect } from "vitest";
import { parseProFile } from "../../src/lib/pro-parser.js";
import { serializeToPro } from "../../src/lib/pro-serializer.js";
import type { DataSource } from "../../src/types.js";

// Line codes below were verified two ways: by scanning 1001 .pro files written
// by TM1 11.8 (30 of them ODBC) and by a write probe — create a process over
// REST with marker values, then read the .pro TM1 itself wrote:
//   586        DataSourceNameForServer      585  DataSourceNameForClient
//   566,<n>    ODBC query, n lines follow   571  subset name
//   570        view name                    564  ODBC user name
// Every ODBC file carries a 566 header; every non-ODBC file carries "566,0".
const REAL_ODBC_PRO = [
  `601,100`,
  `602,"Import_Sales_From_SQL"`,
  `562,"ODBC"`,
  `586,"SALES_DWH"`,
  `585,"SALES_DWH_CLIENT"`,
  `564,"etl_reader"`,
  `565,"<encrypted-blob>"`,
  `559,1`,
  `928,0`,
  `593,`,
  `594,`,
  `595,`,
  `596,`,
  `597,`,
  `598,`,
  `800,`,
  `801,`,
  `566,3`,
  `SELECT Period, Amount`,
  `  FROM dbo.Sales`,
  ` WHERE Year = 2026`,
  `567,","`,
  `588,","`,
  `589,"."`,
  `568,""""`,
  `570,`,
  `571,`,
  `569,0`,
  `592,0`,
  `599,1000`,
  `560,0`,
  `561,0`,
  `590,0`,
  `637,0`,
  `577,0`,
  `603,0`,
  `572,1`,
  `sVal = 'x';`,
  `573,0`,
  `574,0`,
  `575,0`,
].join("\n");

// Same layout, but a subset source: dimension in 586, subset in 571.
const REAL_SUBSET_PRO = [
  `601,100`,
  `602,"Build_Cost_Centers"`,
  `562,"SUBSET"`,
  `586,"CostCenter"`,
  `585,"CostCenter"`,
  `566,0`,
  `570,`,
  `571,"N-Elements"`,
  `569,0`,
  `572,0`,
  `573,0`,
  `574,0`,
  `575,0`,
].join("\n");

describe("pro-parser: real TM1 line codes", () => {
  it("reads the ODBC query from the 566 block", () => {
    const ds = parseProFile(REAL_ODBC_PRO).dataSource;
    expect(ds.type).toBe("ODBC");
    expect(ds.query).toBe(
      "SELECT Period, Amount\n  FROM dbo.Sales\n WHERE Year = 2026",
    );
  });

  it("maps 586 to the server name and 585 to the client name", () => {
    const ds = parseProFile(REAL_ODBC_PRO).dataSource;
    expect(ds.dataSourceNameForServer).toBe("SALES_DWH");
    expect(ds.dataSourceNameForClient).toBe("SALES_DWH_CLIENT");
    expect(ds.userName).toBe("etl_reader");
  });

  it("never carries the encrypted password blob into the datasource", () => {
    const ds = parseProFile(REAL_ODBC_PRO).dataSource;
    expect(ds.password).toBeUndefined();
  });

  it("reads the subset name from 571", () => {
    const ds = parseProFile(REAL_SUBSET_PRO).dataSource;
    expect(ds).toMatchObject({
      type: "TM1DimensionSubset",
      dataSourceNameForServer: "CostCenter",
      subset: "N-Elements",
    });
  });

  it("does not mistake the query body for header codes", () => {
    // A SQL line that starts like a .pro header must not be read as one.
    const pro = REAL_ODBC_PRO.replace(
      `  FROM dbo.Sales`,
      `  FROM dbo."570,Sales"`,
    );
    const ds = parseProFile(pro).dataSource;
    expect(ds.type).toBe("ODBC");
    expect(ds.query).toContain(`570,Sales`);
  });

  it("still reads files this serializer wrote before the fix (585 only, subset in 570)", () => {
    const legacy = [
      `602,"Legacy"`,
      `562,SUBSET`,
      `585,"CostCenter"`,
      `570,"All"`,
      `572,`,
      `sVal = 'x';`,
      `573,`,
      `574,`,
      `575,`,
    ].join("\n");
    expect(parseProFile(legacy).dataSource).toMatchObject({
      type: "TM1DimensionSubset",
      dataSourceNameForServer: "CostCenter",
      dataSourceNameForClient: "CostCenter",
      subset: "All",
    });
  });
});

describe("pro-serializer: datasource fields", () => {
  const base = { name: "P", prolog: "sVal = 'x';" };

  it("round-trips a multi-line ODBC query", () => {
    const ds: DataSource = {
      type: "ODBC",
      dataSourceNameForServer: "SALES_DWH",
      dataSourceNameForClient: "SALES_DWH",
      userName: "etl_reader",
      query: "SELECT A\nFROM T\nWHERE X = 1",
    };
    const out = serializeToPro({ ...base, dataSource: ds });
    expect(out).toContain("566,3\nSELECT A\nFROM T\nWHERE X = 1\n");
    expect(parseProFile(out).dataSource).toMatchObject({
      type: "ODBC",
      userName: "etl_reader",
      query: "SELECT A\nFROM T\nWHERE X = 1",
    });
  });

  it("normalises CRLF in the query to single lines (TM1 returns CRLF over REST)", () => {
    const ds: DataSource = {
      type: "ODBC",
      dataSourceNameForServer: "D",
      query: "SELECT A\r\nFROM T",
    };
    const out = serializeToPro({ ...base, dataSource: ds });
    expect(out).toContain("566,2\nSELECT A\nFROM T\n");
  });

  it("writes an empty query block for ODBC without a query", () => {
    const ds: DataSource = { type: "ODBC", dataSourceNameForServer: "D" };
    expect(serializeToPro({ ...base, dataSource: ds })).toContain("566,0\n");
  });

  it("writes the server name to 586 and the client name to 585", () => {
    const ds: DataSource = {
      type: "ODBC",
      dataSourceNameForServer: "SRV",
      dataSourceNameForClient: "CLI",
    };
    const out = serializeToPro({ ...base, dataSource: ds });
    expect(out).toContain(`586,"SRV"`);
    expect(out).toContain(`585,"CLI"`);
  });

  it("writes the subset to 571 and the view to 570", () => {
    const subset = serializeToPro({
      ...base,
      dataSource: {
        type: "TM1DimensionSubset",
        dataSourceNameForServer: "CostCenter",
        subset: "All",
      },
    });
    expect(subset).toContain(`571,"All"`);
    expect(subset).not.toContain(`570,"All"`);

    const view = serializeToPro({
      ...base,
      dataSource: {
        type: "TM1CubeView",
        dataSourceNameForServer: "Sales",
        view: "MyView",
      },
    });
    expect(view).toContain(`570,"MyView"`);
  });

  it("quotes the datasource type like TM1 does", () => {
    const out = serializeToPro({
      ...base,
      dataSource: { type: "ODBC", dataSourceNameForServer: "D" },
    });
    expect(out).toContain(`562,"ODBC"`);
  });

  it("never writes the ODBC password", () => {
    const out = serializeToPro({
      ...base,
      dataSource: {
        type: "ODBC",
        dataSourceNameForServer: "D",
        userName: "u",
        password: "s3cret",
      },
    });
    expect(out).not.toContain("s3cret");
  });

  it("writes section line counts and survives code that looks like a header", () => {
    const out = serializeToPro({
      ...base,
      prolog: "sVal = 'x';\n930,0\nsOther = 'y';",
      dataSource: { type: "None" },
    });
    expect(out).toContain("572,3\n");
    expect(parseProFile(out).prolog).toBe("sVal = 'x';\n930,0\nsOther = 'y';");
  });
});
