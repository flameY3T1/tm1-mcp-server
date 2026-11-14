import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type pino from "pino";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import type { FnSpy } from "../helpers/spy-types.js";
import { TM1Client } from "../../src/tm1-client.js";
import { SessionManager } from "../../src/session-manager.js";
import { baseTestConfig } from "../helpers/tm1-config.js";

const OK = { ProcessExecuteStatusCode: "CompletedSuccessfully" };

function json(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}
function notFound(): Response {
  return {
    ok: false,
    status: 404,
    statusText: "Not Found",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(""),
  } as unknown as Response;
}
function raw(text: string | Uint8Array): Response {
  const bytes =
    typeof text === "string" ? new TextEncoder().encode(text) : text;
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(new TextDecoder().decode(bytes)),
    arrayBuffer: vi.fn().mockResolvedValue(bytes.slice().buffer),
  } as unknown as Response;
}

describe("FileService.readViaTi", () => {
  let fetchSpy: FnSpy;
  let client: TM1Client;
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: "silent",
    flush: vi.fn(),
  } as unknown as pino.Logger;

  beforeEach(() => {
    fetchSpy = vi.fn();
    stubContractCheckedFetch(fetchSpy);
    const config = {
      ...baseTestConfig,
      baseUrl: "https://tm1server:8010",
      user: "admin",
      password: "secret",
    };
    const sm = new SessionManager(config, logger);
    vi.spyOn(sm, "ensureSession").mockResolvedValue("s");
    vi.spyOn(sm, "authenticate").mockResolvedValue("s");
    vi.spyOn(sm, "startKeepAlive").mockImplementation(() => {});
    vi.spyOn(sm, "stopKeepAlive").mockImplementation(() => {});
    client = new TM1Client(config, sm, logger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("copies the file through TI, returns its lines and deletes the copy", async () => {
    fetchSpy
      .mockResolvedValueOnce(json(OK))
      .mockResolvedValueOnce(raw('Konto;Wert\r\n"K100;1500,00"\r\nä€\r\n'))
      .mockResolvedValueOnce(json({}));

    const r = await client.files.readViaTi("C:\\data\\export.csv", 1000);

    expect(r).toEqual({
      lines: ["Konto;Wert", '"K100;1500,00"', "ä€"],
      truncated: false,
      encoding: "utf-8",
    });
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toContain(
      "/api/v1/ExecuteProcessWithReturn?$expand=ErrorLogFile",
    );
    const p = JSON.parse(opts.body).Process;
    expect(p.DataSource.dataSourceNameForServer).toBe("C:\\data\\export.csv");
    expect(p.DataSource.asciiQuoteCharacter).toBe("");
    // The path must never reach TI code.
    expect(p.PrologProcedure + p.DataProcedure).not.toContain("export.csv");
    expect(p.DataProcedure).toContain("IF(n > 1001);");
    const copy = /TM1ProcessError_mcpread_[0-9a-f-]+\.log/.exec(
      p.PrologProcedure,
    )![0];
    expect(fetchSpy.mock.calls[1][0]).toContain(
      `ErrorLogFiles('${copy}')/Content`,
    );
    const [delUrl, delOpts] = fetchSpy.mock.calls[2];
    expect(delUrl).toContain(`ErrorLogFiles('${copy}')`);
    expect(delOpts.method).toBe("DELETE");
  });

  it("returns no lines for an empty file, which leaves no copy", async () => {
    fetchSpy.mockResolvedValueOnce(json(OK)).mockResolvedValueOnce(notFound());
    expect(await client.files.readViaTi("empty.csv", 10)).toEqual({
      lines: [],
      truncated: false,
      encoding: "utf-8",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("cuts at maxLines and says so", async () => {
    fetchSpy
      .mockResolvedValueOnce(json(OK))
      .mockResolvedValueOnce(raw("a\r\nb\r\nc\r\n"))
      .mockResolvedValueOnce(json({}));
    const r = await client.files.readViaTi("x.csv", 2);
    expect(r.lines).toEqual(["a", "b"]);
    expect(r.truncated).toBe(true);
  });

  it("decodes an ANSI file as windows-1252", async () => {
    fetchSpy
      .mockResolvedValueOnce(json(OK))
      .mockResolvedValueOnce(
        raw(
          Uint8Array.from([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72, 0x80, 13, 10]),
        ),
      )
      .mockResolvedValueOnce(json({}));
    const r = await client.files.readViaTi("ansi.csv", 10);
    expect(r.lines).toEqual(["Müller€"]);
    expect(r.encoding).toBe("windows-1252");
  });

  it("raises NOT_FOUND with the server log when TI cannot open the file", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        json({
          ProcessExecuteStatusCode: "Aborted",
          ErrorLogFile: { Filename: "c.log" },
        }),
      )
      .mockResolvedValueOnce(
        raw("Error: Prolog procedure line (0): Unable to open data source"),
      )
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(notFound());
    await expect(
      client.files.readViaTi("missing.csv", 10),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Both the process's own error log and the (possibly partial) copy go.
    expect(fetchSpy.mock.calls[2][0]).toContain("ErrorLogFiles('c.log')");
    expect(fetchSpy.mock.calls[2][1].method).toBe("DELETE");
    expect(fetchSpy.mock.calls[3][0]).toContain("TM1ProcessError_mcpread_");
    expect(fetchSpy.mock.calls[3][1].method).toBe("DELETE");
  });
});
