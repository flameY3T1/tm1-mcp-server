import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
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

// A symlink placed INSIDE the root that points outside it passes the lexical
// check — the realpath-based second check must catch it. Uses a real tmpdir
// because symlink resolution needs an actual filesystem.
describe("resolveLocalPath symlink confinement", () => {
  let base: string;
  let root: string;
  let outside: string;
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.TM1_LOCAL_FILE_ROOT;
    base = mkdtempSync(path.join(os.tmpdir(), "tm1-local-file-"));
    root = path.join(base, "root");
    outside = path.join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    // root/link -> ../outside : lexically inside the root, really outside it
    symlinkSync(outside, path.join(root, "link"));
    process.env.TM1_LOCAL_FILE_ROOT = root;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.TM1_LOCAL_FILE_ROOT;
    else process.env.TM1_LOCAL_FILE_ROOT = prev;
    rmSync(base, { recursive: true, force: true });
  });

  it("rejects a write path through a symlink that escapes the root", () => {
    expect(() => resolveLocalPath(path.join(root, "link", "evil.pro"))).toThrow(TM1Error);
    expect(() => resolveLocalPath(path.join(root, "link", "evil.pro"))).toThrow(/escapes/);
  });

  it("rejects the symlink itself as a directory target", () => {
    expect(() => resolveLocalPath(path.join(root, "link"), "directory")).toThrow(/escapes/);
  });

  it("still accepts a normal (not-yet-existing) path inside the root", () => {
    const target = path.join(root, "deploy", "load.pro");
    expect(resolveLocalPath(target)).toBe(target);
  });

  it("accepts paths when the root itself is a symlink", () => {
    // e.g. TM1_LOCAL_FILE_ROOT=/tmp where /tmp is a symlink on some systems
    const rootLink = path.join(base, "root-link");
    symlinkSync(root, rootLink);
    process.env.TM1_LOCAL_FILE_ROOT = rootLink;
    const target = path.join(rootLink, "x.pro");
    expect(resolveLocalPath(target)).toBe(target);
  });
});
