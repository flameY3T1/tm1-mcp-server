// Live coverage for datasource columns set to "Ignore".
//
// Such a column carries no variable, so it is absent from `Process.Variables`
// and lives only in `VariablesUIData` — a property neither version declares in
// $metadata. Every path that reads or rewrites a process therefore has to name
// it explicitly, and this suite is what proves the ones that claim to: the
// reads report the column, copy carries it, and .pro and git survive a full
// export → import round trip.
//
// The fixture is built through the raw client rather than a tool because no
// tool takes UI data as input: the setting is made in Architect and only ever
// carried, never authored, here.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getHarness,
  LIVE_ENABLED,
  SANDBOX,
  type LiveHarness,
} from "./harness.js";

const SRC = `${SANDBOX}_IGNCOL_SRC`;
const PLAIN = `${SANDBOX}_IGNCOL_PLAIN`;
const COPY = `${SANDBOX}_IGNCOL_COPY`;
const FROM_PRO = `${SANDBOX}_IGNCOL_PRO`;
const FROM_GIT = `${SANDBOX}_IGNCOL_GIT`;
const ALL = [SRC, PLAIN, COPY, FROM_PRO, FROM_GIT];

// Column 1 is ignored, columns 2 and 3 carry the two variables — which is why
// their positions start at 2.
const IGNORED_ENTRY =
  "IgnoredInputVarName=vsDropped\fVarType=32\fColType=1165\f";
const UI_DATA = [
  IGNORED_ENTRY,
  "VarType=32\fColType=827\f",
  "VarType=33\fColType=827\f",
];
const VARIABLES = [
  { Name: "vsKeep", Type: "String", Position: 2, StartByte: 0, EndByte: 0 },
  { Name: "vnKeep", Type: "Numeric", Position: 3, StartByte: 0, EndByte: 0 },
];
// A non-empty tab: the git layout writes the code as a #region blob, and an
// all-empty process would export an empty .ti that no import can take.
const PROLOG = "# ignored-column live fixture\r\nnFoo = 1;";

const ASCII_SOURCE = {
  Type: "ASCII",
  dataSourceNameForServer: "ignored-columns-probe.csv",
  asciiDelimiterType: "Character",
  asciiDelimiterChar: ";",
  asciiHeaderRecords: 0,
  asciiQuoteCharacter: '"',
  asciiDecimalSeparator: ".",
  asciiThousandSeparator: ",",
};

interface RawHttp {
  request: (method: string, path: string, body?: unknown) => Promise<unknown>;
}

function httpOf(h: LiveHarness): RawHttp {
  return (h.client as unknown as { http: RawHttp }).http;
}

async function dropProcess(h: LiveHarness, name: string): Promise<void> {
  try {
    await httpOf(h).request("DELETE", `/api/v1/Processes('${name}')`);
  } catch {
    /* absent is the desired state */
  }
}

async function createProcess(
  h: LiveHarness,
  name: string,
  uiData: string[] | undefined,
): Promise<void> {
  await dropProcess(h, name);
  await httpOf(h).request("POST", "/api/v1/Processes", {
    Name: name,
    PrologProcedure: PROLOG,
    MetadataProcedure: "",
    DataProcedure: "",
    EpilogProcedure: "",
    DataSource: ASCII_SOURCE,
    Variables: VARIABLES,
    ...(uiData !== undefined ? { VariablesUIData: uiData } : {}),
  });
}

describe.skipIf(!LIVE_ENABLED)("live: ignored datasource columns", () => {
  let h: LiveHarness;

  beforeAll(async () => {
    h = await getHarness();
    // SRC ignores column 1; PLAIN is the same process without the ignore, so
    // the diff has something to find.
    await createProcess(h, SRC, UI_DATA);
    await createProcess(h, PLAIN, undefined);
  }, 60_000);

  afterAll(async () => {
    for (const name of ALL) await dropProcess(h, name);
  }, 60_000);

  it("tm1_get_process_variables reports the ignored column", async () => {
    const r = await h.ok("tm1_get_process_variables", { processName: SRC });
    expect(r.json.variables.map((v: { name: string }) => v.name)).toEqual([
      "vsKeep",
      "vnKeep",
    ]);
    expect(r.json.ignoredColumns).toEqual([{ position: 1, name: "vsDropped" }]);
  });

  it("tm1_get_process reports it alongside the variables", async () => {
    const r = await h.ok("tm1_get_process", { processName: SRC });
    expect(r.json.ignoredColumns).toEqual([{ position: 1, name: "vsDropped" }]);
    // A process that ignores nothing says nothing — the field is omitted.
    const plain = await h.ok("tm1_get_process", { processName: PLAIN });
    expect(plain.json.ignoredColumns).toBeUndefined();
  });

  it("tm1_copy_process carries the ignored column to the copy", async () => {
    await h.ok("tm1_copy_process", { sourceName: SRC, targetName: COPY });
    const r = await h.ok("tm1_get_process_variables", { processName: COPY });
    expect(r.json.ignoredColumns).toEqual([{ position: 1, name: "vsDropped" }]);
  });

  it("survives a .pro export → import round trip", async () => {
    const exported = await h.ok("tm1_export_process_to_pro", {
      processName: SRC,
    });
    // The block counts COLUMNS: three entries for two variables.
    expect(exported.json.content).toContain("582,3");
    expect(exported.json.content).toContain("IgnoredInputVarName=vsDropped");

    await h.ok("tm1_import_pro_file", {
      content: exported.json.content,
      processName: FROM_PRO,
      mode: "create",
    });
    const r = await h.ok("tm1_get_process_variables", {
      processName: FROM_PRO,
    });
    expect(r.json.ignoredColumns).toEqual([{ position: 1, name: "vsDropped" }]);
  });

  it("survives a git export → import round trip", async () => {
    const exported = await h.ok("tm1_export_process_to_git", {
      processName: SRC,
    });
    expect(JSON.parse(exported.json.json).VariablesUIData).toEqual(UI_DATA);

    await h.ok("tm1_import_process_from_git", {
      jsonContent: exported.json.json,
      tiContent: exported.json.ti,
      processName: FROM_GIT,
      mode: "create",
    });
    const r = await h.ok("tm1_get_process_variables", {
      processName: FROM_GIT,
    });
    expect(r.json.ignoredColumns).toEqual([{ position: 1, name: "vsDropped" }]);
  });

  it("tm1_diff_processes sees a difference the variables cannot show", async () => {
    const r = await h.ok("tm1_diff_processes", {
      processA: SRC,
      processB: PLAIN,
    });
    // Identical variable lists — the processes differ only in the ignore flag.
    expect(r.json.variables.identical).toBe(true);
    expect(r.json.ignoredColumns.identical).toBe(false);
    expect(r.json.ignoredColumns.removed).toEqual([1]);
    expect(r.json.identical).toBe(false);
  });
});
