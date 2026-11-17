// sourcePath exists so a spreadsheet reaches the server without its bytes
// passing through the conversation. The fixture is NOT valid UTF-8 on purpose:
// a text read of the file would pass with Buffer.from("payload").
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  promises as fsPromises,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { z, type ZodRawShape } from "zod";
import { registerUploadFile } from "../../src/tools/fileops/upload-file.js";
import type { TM1Client } from "../../src/tm1-client.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

const BINARY = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x80, 0xff, 0x00, 0xfe]);
const SHA = createHash("sha256").update(BINARY).digest("hex");

function setup(readBack: () => Promise<Buffer>) {
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
  const upload = vi.fn(async () => ({ created: true, root: "Applications" }));
  const client = {
    files: { upload, getContentBytes: vi.fn(readBack) },
  } as unknown as TM1Client;
  registerUploadFile(
    server as unknown as Parameters<typeof registerUploadFile>[0],
    client,
  );
  const h = captured as ToolHandler | null;
  const p = parser as z.ZodObject<ZodRawShape> | null;
  if (!h || !p) throw new Error("handler not registered");
  const run = async (args: Record<string, unknown>) =>
    JSON.parse((await h(p.parse(args))).content[0].text) as Record<
      string,
      unknown
    >;
  return { run, upload };
}

describe("tm1_upload_file, sourcePath and verification", () => {
  let dir: string;
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.TM1_LOCAL_FILE_ROOT;
    dir = mkdtempSync(path.join(os.tmpdir(), "tm1-upload-"));
    process.env.TM1_LOCAL_FILE_ROOT = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.TM1_LOCAL_FILE_ROOT;
    else process.env.TM1_LOCAL_FILE_ROOT = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends the file's bytes unchanged and verifies them by hash", async () => {
    const src = path.join(dir, "book.xlsm");
    writeFileSync(src, BINARY);
    const { run, upload } = setup(async () => BINARY);

    const out = await run({
      fileName: "Reports/book.xlsm",
      sourcePath: src,
      container: "applications",
      confirm: "Reports/book.xlsm",
    });

    expect(upload).toHaveBeenCalledWith(
      "Reports/book.xlsm",
      BINARY,
      "applications",
      false,
    );
    expect(out).toMatchObject({
      success: true,
      bytesUploaded: BINARY.byteLength,
      sha256: SHA,
      verified: true,
    });
  });

  it("reports verified=false when the server holds other bytes", async () => {
    const { run } = setup(async () => Buffer.from("other"));
    const out = await run({
      fileName: "a.csv",
      content: "x",
      confirm: "a.csv",
    });
    expect(out).toMatchObject({ success: true, verified: false });
  });

  it("keeps the upload and reports verified=false when the read-back fails", async () => {
    const { run } = setup(async () => {
      throw new Error("timeout");
    });
    const out = await run({
      fileName: "a.csv",
      content: "x",
      confirm: "a.csv",
    });
    expect(out).toMatchObject({ success: true, verified: false });
  });

  it("refuses both and neither of content and sourcePath, sending nothing", async () => {
    const { run, upload } = setup(async () => BINARY);
    await expect(run({ fileName: "a.csv", confirm: "a.csv" })).rejects.toThrow(
      /exactly one of content or sourcePath/,
    );
    await expect(
      run({
        fileName: "a.csv",
        content: "x",
        sourcePath: path.join(dir, "a.csv"),
        confirm: "a.csv",
      }),
    ).rejects.toThrow(/exactly one of content or sourcePath/);
    expect(upload).not.toHaveBeenCalled();
  });

  it("refuses an oversized sourcePath by its size, without loading it", async () => {
    // Sparse: 33 MB on paper, nothing on disk.
    const src = path.join(dir, "big.bin");
    writeFileSync(src, "");
    truncateSync(src, 33 * 1024 * 1024);
    const read = vi.spyOn(fsPromises, "readFile");
    const { run, upload } = setup(async () => BINARY);
    const out = await run({
      fileName: "big.bin",
      sourcePath: src,
      confirm: "big.bin",
    });
    expect(out).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(read).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    read.mockRestore();
  });

  it("refuses a sourcePath outside the root", async () => {
    const { run, upload } = setup(async () => BINARY);
    await expect(
      run({ fileName: "a.csv", sourcePath: "/etc/passwd", confirm: "a.csv" }),
    ).rejects.toThrow(/escapes/);
    expect(upload).not.toHaveBeenCalled();
  });
});
