import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// tests/live/load-env.ts is a side-effect module. dotenv is mocked, so the
// developer's real repo .env (which points at PROD) can neither satisfy nor
// break these cases — the test only asserts WHETHER .env would be read.

const config = vi.fn();
const savedBaseUrl = process.env.TM1_BASE_URL;

beforeEach(() => {
  config.mockClear();
  vi.resetModules();
  vi.doMock("dotenv", () => ({ config }));
});

afterEach(() => {
  vi.doUnmock("dotenv");
  if (savedBaseUrl === undefined) delete process.env.TM1_BASE_URL;
  else process.env.TM1_BASE_URL = savedBaseUrl;
});

describe("live harness load-env", () => {
  it("does not read .env when a target is already configured", async () => {
    // What the nightly runner does: one target's block, TM1_PASSWORD absent.
    process.env.TM1_BASE_URL = "http://localhost:4444";

    await import("../live/load-env.js");

    expect(config).not.toHaveBeenCalled();
  });

  it("reads .env when no target is configured", async () => {
    delete process.env.TM1_BASE_URL;

    await import("../live/load-env.js");

    expect(config).toHaveBeenCalledOnce();
  });
});
