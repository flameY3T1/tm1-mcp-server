// encoding='base64' exists so an Applications spreadsheet survives the trip:
// a UTF-8 decode replaces every invalid byte with U+FFFD, and that loss is
// silent. These tests use bytes that are NOT valid UTF-8 on purpose — a
// fixture like Buffer.from("payload") would pass either way.
import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z, type ZodRawShape } from "zod";
import { registerGetFileContent } from "../../src/tools/fileops/get-file-content.js";
import { FileContentResultSchema } from "../../src/tools/schemas/items.js";
import type { TM1Client } from "../../src/tm1-client.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

// 0x80 is a continuation byte with nothing to continue: invalid UTF-8.
const BINARY = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x80, 0xff, 0x00, 0xfe]);

function handlerFor(bytes: Buffer): ToolHandler {
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
  const client = {
    files: { getContentBytes: vi.fn(async () => bytes) },
  } as unknown as TM1Client;
  registerGetFileContent(
    server as unknown as Parameters<typeof registerGetFileContent>[0],
    client,
  );
  // Read back through explicit types: TS narrows the closure variables to
  // `never` because it cannot see that register* called `tool` synchronously.
  const h = captured as ToolHandler | null;
  const p = parser as z.ZodObject<ZodRawShape> | null;
  if (!h || !p) throw new Error("handler not registered");
  return (args) => h(p.parse(args));
}

async function payload(args: Record<string, unknown>, bytes = BINARY) {
  const res = await handlerFor(bytes)(args);
  // The SDK rejects a payload the declared output schema does not accept, so
  // the shape is asserted here rather than only the values.
  return FileContentResultSchema.parse(JSON.parse(res.content[0].text));
}

describe("tm1_get_file_content, base64 encoding", () => {
  it("returns bytes that are not valid UTF-8 unchanged", async () => {
    const out = await payload({ fileName: "book.xlsx", encoding: "base64" });
    expect(Buffer.from(out.content ?? "", "base64")).toEqual(BINARY);
    expect(out.totalBytes).toBe(BINARY.byteLength);
    expect(out.returnedBytes).toBe(BINARY.byteLength);
    expect(out.truncated).toBe(false);
  });

  it("truncates to maxBytes and counts the bytes, not the base64 characters", async () => {
    const out = await payload({
      fileName: "book.xlsx",
      encoding: "base64",
      maxBytes: 4,
    });
    expect(Buffer.from(out.content ?? "", "base64")).toEqual(
      BINARY.subarray(0, 4),
    );
    expect(out.returnedBytes).toBe(4);
    expect(out.totalBytes).toBe(BINARY.byteLength);
    expect(out.truncated).toBe(true);
    expect(out.truncationReason).toBe("maxBytes=4");
  });

  it("shows what a text read costs on the same bytes", async () => {
    const out = await payload({ fileName: "book.xlsx" });
    expect(out.content).toContain("�");
  });
});

describe("tm1_get_file_content, writeToFile", () => {
  it("writes every byte to disk and keeps the content out of the response", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tm1-get-file-"));
    const prev = process.env.TM1_LOCAL_FILE_ROOT;
    process.env.TM1_LOCAL_FILE_ROOT = dir;
    try {
      const target = path.join(dir, "sub", "book.xlsx");
      // maxBytes must not cut a file that goes to disk.
      const out = await payload({
        fileName: "book.xlsx",
        writeToFile: target,
        maxBytes: 4,
      });
      expect(readFileSync(target)).toEqual(BINARY);
      expect(out).toEqual({
        fileName: "book.xlsx",
        totalBytes: BINARY.byteLength,
        writtenTo: target,
        sha256: createHash("sha256").update(BINARY).digest("hex"),
      });
    } finally {
      if (prev === undefined) delete process.env.TM1_LOCAL_FILE_ROOT;
      else process.env.TM1_LOCAL_FILE_ROOT = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a path outside the root before any download", async () => {
    const prev = process.env.TM1_LOCAL_FILE_ROOT;
    process.env.TM1_LOCAL_FILE_ROOT = path.resolve("/srv/allowed");
    try {
      await expect(
        payload({ fileName: "book.xlsx", writeToFile: "/etc/book.xlsx" }),
      ).rejects.toThrow(/escapes/);
    } finally {
      if (prev === undefined) delete process.env.TM1_LOCAL_FILE_ROOT;
      else process.env.TM1_LOCAL_FILE_ROOT = prev;
    }
  });
});
