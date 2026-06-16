import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// load-env.ts is a side-effect module: it calls dotenv at import time. We drive
// it via a fresh dynamic import (vi.resetModules) per case, controlling
// process.env and an on-disk env file. All assertions use unique key names so a
// developer's real repo .env (cwd/.env and <packageRoot>/.env both resolve to
// the repo root during the test run) can never satisfy or break them.

const KEY = "TM1_TEST_DOTENV_CONFIG_PATH_PROBE";
const PREEXISTING_KEY = "TM1_TEST_PREEXISTING_PROBE";

let tmp: string;
const savedConfigPath = process.env.DOTENV_CONFIG_PATH;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "load-env-test-"));
  delete process.env[KEY];
  delete process.env[PREEXISTING_KEY];
  delete process.env.DOTENV_CONFIG_PATH;
  vi.resetModules();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env[KEY];
  delete process.env[PREEXISTING_KEY];
  if (savedConfigPath === undefined) {
    delete process.env.DOTENV_CONFIG_PATH;
  } else {
    process.env.DOTENV_CONFIG_PATH = savedConfigPath;
  }
});

describe("load-env DOTENV_CONFIG_PATH handling", () => {
  it("loads variables from the file named by DOTENV_CONFIG_PATH", async () => {
    const envFile = join(tmp, "custom.env");
    writeFileSync(envFile, `${KEY}=from_custom_path\n`);
    process.env.DOTENV_CONFIG_PATH = envFile;

    await import("../../src/load-env.js");

    expect(process.env[KEY]).toBe("from_custom_path");
  });

  it("does not overwrite a real env var already set (real env > $DOTENV_CONFIG_PATH)", async () => {
    const envFile = join(tmp, "custom.env");
    writeFileSync(envFile, `${PREEXISTING_KEY}=from_file\n`);
    process.env.DOTENV_CONFIG_PATH = envFile;
    process.env[PREEXISTING_KEY] = "from_real_env";

    await import("../../src/load-env.js");

    expect(process.env[PREEXISTING_KEY]).toBe("from_real_env");
  });

  it("does not throw when DOTENV_CONFIG_PATH is unset", async () => {
    expect(process.env.DOTENV_CONFIG_PATH).toBeUndefined();
    await expect(import("../../src/load-env.js")).resolves.toBeDefined();
  });

  it("does not throw when DOTENV_CONFIG_PATH points to a missing file", async () => {
    process.env.DOTENV_CONFIG_PATH = join(tmp, "does-not-exist.env");
    await expect(import("../../src/load-env.js")).resolves.toBeDefined();
    expect(process.env[KEY]).toBeUndefined();
  });
});
