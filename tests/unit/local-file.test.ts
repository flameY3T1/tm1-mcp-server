import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { resolveLocalPath } from "../../src/tools/local-file.js";
import { TM1Error } from "../../src/types.js";

// resolveLocalPath confines caller-supplied host paths to TM1_LOCAL_FILE_ROOT.
// Default-off: with the env unset, host-file access is disabled entirely.
describe("resolveLocalPath", () => {
  const ROOT = path.resolve("/srv/pro-bundles");
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.TM1_LOCAL_FILE_ROOT;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.TM1_LOCAL_FILE_ROOT;
    else process.env.TM1_LOCAL_FILE_ROOT = prev;
  });

  it("is disabled when TM1_LOCAL_FILE_ROOT is unset", () => {
    delete process.env.TM1_LOCAL_FILE_ROOT;
    expect(() => resolveLocalPath("/srv/pro-bundles/x.pro")).toThrow(TM1Error);
    expect(() => resolveLocalPath("/srv/pro-bundles/x.pro")).toThrow(/Host-file access is disabled/);
  });

  it("is disabled when the root is blank/whitespace", () => {
    process.env.TM1_LOCAL_FILE_ROOT = "   ";
    expect(() => resolveLocalPath("/srv/pro-bundles/x.pro")).toThrow(/disabled/);
  });

  it("returns the resolved path for a file inside the root", () => {
    process.env.TM1_LOCAL_FILE_ROOT = ROOT;
    expect(resolveLocalPath(path.join(ROOT, "deploy", "load.pro"))).toBe(path.join(ROOT, "deploy", "load.pro"));
  });

  it("allows the root directory itself (e.g. a bundle directory == root)", () => {
    process.env.TM1_LOCAL_FILE_ROOT = ROOT;
    expect(resolveLocalPath(ROOT, "directory")).toBe(ROOT);
  });

  it("rejects a relative path", () => {
    process.env.TM1_LOCAL_FILE_ROOT = ROOT;
    expect(() => resolveLocalPath("deploy/load.pro")).toThrow(/must be absolute/);
  });

  it("rejects traversal that escapes the root via ..", () => {
    process.env.TM1_LOCAL_FILE_ROOT = ROOT;
    expect(() => resolveLocalPath(path.join(ROOT, "..", "secret", "id_rsa"))).toThrow(/escapes/);
  });

  it("rejects an absolute path outside the root (e.g. /etc/passwd)", () => {
    process.env.TM1_LOCAL_FILE_ROOT = ROOT;
    expect(() => resolveLocalPath("/etc/passwd")).toThrow(/escapes/);
  });

  it("rejects a sibling-prefix path that is not actually inside the root", () => {
    process.env.TM1_LOCAL_FILE_ROOT = ROOT;
    // /srv/pro-bundles-evil shares the string prefix but is a different dir
    expect(() => resolveLocalPath("/srv/pro-bundles-evil/x.pro")).toThrow(/escapes/);
  });
});
