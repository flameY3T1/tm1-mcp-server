// TM1 v12 / Planning Analytics Engine 12.5.9 ships NO `}Stats*` performance
// control cubes (measured: v11 11.8 has all seven, v12 has only security and
// element-attribute control cubes). The shared `}StatsByCube` fetcher used to
// let TM1's raw OData text reach the model, which reads like the user's model
// is broken.
//
// These tests pin the honest degradation, the distinction between "this
// server does not expose the statistics cubes" (absent) and "your account may
// not read them" (denied — TM1 answers HTTP 400 `ObjectSecurityNoReadRights`,
// not 403), and above all that NONE of it is decided by reading the error
// sentence. Measured on this project's own servers, one question, three
// answers:
//
//   v11 11.8 (en) : '}StatsByCube' can not be found in collection of type 'Cube'
//   v12 12.5.9    : There is no cube named "}StatsByCube".
//   v11 11.8 (de) : Syntaxfehler bei oder in der Nähe von: '[…]', Zeichenposition 67
//
// All three are exercised below against the same structural detection: the
// untranslated denial identifier, then `GET Cubes('}StatsByCube')`.
import { describe, it, expect } from "vitest";
import { z, type ZodRawShape } from "zod";
import {
  fetchCubeStats,
  CubeStatsUnavailableError,
} from "../../src/lib/cube-stats/fetcher.js";
import { registerGetCubeStats } from "../../src/tools/operations/get-cube-stats.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";
import type { TM1Client } from "../../src/tm1-client.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function makeFakeServer() {
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
  return {
    server: server as unknown as Parameters<typeof registerGetCubeStats>[0],
    getHandler: (): ToolHandler => {
      if (!captured || !parser) throw new Error("handler not registered");
      const p = parser;
      const h = captured;
      return (args) => h(p.parse(args));
    },
  };
}

function mdxError(text: string): TM1Error {
  return new TM1Error({
    code: TM1ErrorCode.TM1_ERROR,
    message: text,
    httpStatus: 400,
    endpoint: "/api/v1/ExecuteMDX",
    details: text,
  });
}

/** What v11 11.8 (English locale) says. */
const V11_EN_MISSING = mdxError(
  "'}StatsByCube' can not be found in collection of type 'Cube'",
);
/** What v12 12.5.9 says for the very same condition — different sentence. */
const V12_MISSING = mdxError('There is no cube named "}StatsByCube".');
/** What v11 11.8 on a GERMAN server says. Real output from this project's
 *  test server; the reason no matcher here reads prose. */
const V11_DE_MISSING = mdxError(
  "Syntaxfehler bei oder in der Nähe von: '[ZZ_NO_SUCH_STATS_CUBE]', Zeichenposition 67",
);

/** A non-admin reading a control cube: HTTP 400, not 403 (documented TM1).
 *  `classifyHttpError` turns the identifier into PERMISSION_DENIED. */
const DENIED = new TM1Error({
  code: TM1ErrorCode.PERMISSION_DENIED,
  message: "ObjectSecurityNoReadRights",
  httpStatus: 400,
  endpoint: "/api/v1/ExecuteMDX",
  details: "ObjectSecurityNoReadRights",
});

interface StubOpts {
  version?: 11 | 12;
  /** Thrown by executeMdx. When absent, `stats` is returned instead. */
  failWith?: Error;
  stats?: Record<string, number>;
  /** Does `GET Cubes('}StatsByCube')` find the cube? Default: yes. */
  statsCubeExists?: boolean;
  /** When set, the existence probe itself rejects with this. */
  probeFailsWith?: Error;
}

function makeClientStub(opts: StubOpts) {
  let calls = 0;
  let probes = 0;
  const probed: string[] = [];
  const client = {
    version: opts.version ?? 11,
    cubes: {
      // Mirrors the real CubeService.exists() contract: 404 → false, anything
      // else rethrown. (`CubeService.exists` swallowing the 404 is pinned
      // separately in cube-service-exists.test.ts.)
      exists: async (cubeName: string) => {
        probes++;
        probed.push(cubeName);
        if (opts.probeFailsWith !== undefined) throw opts.probeFailsWith;
        return opts.statsCubeExists !== false;
      },
    },
    cells: {
      executeMdx: async () => {
        calls++;
        if (opts.failWith !== undefined) throw opts.failWith;
        const entries = Object.entries(opts.stats ?? {});
        return {
          axes: [
            { tuples: [] },
            { tuples: entries.map(([name]) => ({ members: [{ name }] })) },
          ],
          cells: entries.map(([, v]) => ({ value: v })),
        };
      },
    },
  };
  return {
    client: client as unknown as TM1Client,
    mdxCalls: () => calls,
    probeCalls: () => probes,
    probedNames: () => probed,
  };
}

function parseJson(raw: unknown) {
  const result = raw as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text);
}

const HEALTHY_STATS = {
  "Total Memory Used": 2048,
  "Number of Populated Numeric Cells": 100,
  "Number of Fed Cells": 400,
};

// ── fetcher: classification ─────────────────────────────────────────────────

describe("fetchCubeStats: }StatsByCube unavailability", () => {
  // The probe decides, so all three wordings must land on the same verdict.
  const wordings: Array<[string, TM1Error]> = [
    ["v11 English", V11_EN_MISSING],
    ["v12", V12_MISSING],
    ["v11 German", V11_DE_MISSING],
  ];
  for (const [label, failure] of wordings) {
    it(`probe 404 → absent, whatever the server's wording (${label})`, async () => {
      const stub = makeClientStub({
        version: 12,
        failWith: failure,
        statsCubeExists: false,
      });
      const err = await fetchCubeStats(stub.client, "Sales").catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(CubeStatsUnavailableError);
      const u = err as CubeStatsUnavailableError;
      expect(u.reason).toBe("absent");
      expect(u.message).toMatch(/}StatsByCube/);
      expect(u.message).toMatch(/v12|Planning Analytics Engine/i);
      // The server's own sentence never reaches the user.
      expect(u.message).not.toContain(failure.message);
      // And it asked the server about the right object.
      expect(stub.probedNames()).toEqual(["}StatsByCube"]);
    });
  }

  it("classifies a security denial by its identifier, before probing at all", async () => {
    const stub = makeClientStub({ version: 11, failWith: DENIED });
    const err = await fetchCubeStats(stub.client, "Sales").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CubeStatsUnavailableError);
    const u = err as CubeStatsUnavailableError;
    expect(u.reason).toBe("denied");
    expect(u.message).toMatch(/permission|rights|refused/i);
    // Must NOT claim the server lacks the statistics cubes — the same lie in
    // the other direction.
    expect(u.message).not.toMatch(/does not exist on this server/);
    // Denial is decided structurally, so no existence probe is needed.
    expect(stub.probeCalls()).toBe(0);
  });

  it("recognises the denial identifier even when it arrives untyped", async () => {
    // A wrapper that lost the TM1Error type still carries the identifier —
    // it is a code, not a sentence, so it survives translation and wrapping.
    const stub = makeClientStub({
      version: 11,
      failWith: new Error("MDX failed: ObjectSecurityNoReadRights"),
    });
    const err = await fetchCubeStats(stub.client, "Sales").catch(
      (e: unknown) => e as CubeStatsUnavailableError,
    );
    expect(err.reason).toBe("denied");
  });

  it("probe 200 → the original error is rethrown untouched", async () => {
    // Regression guard: a genuinely missing USER cube. }StatsByCube is fine;
    // this one request failed. That must stay a per-cube error and never
    // become a server-wide verdict.
    const stub = makeClientStub({
      version: 11,
      failWith: V11_DE_MISSING,
      statsCubeExists: true,
    });
    const err = await fetchCubeStats(stub.client, "ZZ_NO_SUCH_CUBE").catch(
      (e: unknown) => e,
    );
    expect(err).not.toBeInstanceOf(CubeStatsUnavailableError);
    expect(err).toBe(V11_DE_MISSING);
    expect(stub.probeCalls()).toBe(1);
  });

  it("a probe that cannot answer never masks the original error", async () => {
    const stub = makeClientStub({
      version: 11,
      failWith: V11_EN_MISSING,
      probeFailsWith: new Error("connection reset"),
    });
    const err = await fetchCubeStats(stub.client, "Sales").catch(
      (e: unknown) => e,
    );
    expect(err).toBe(V11_EN_MISSING);
  });

  it("a probe refused by security yields denied, not absent", async () => {
    const stub = makeClientStub({
      version: 11,
      failWith: V11_EN_MISSING,
      probeFailsWith: DENIED,
    });
    const err = await fetchCubeStats(stub.client, "Sales").catch(
      (e: unknown) => e as CubeStatsUnavailableError,
    );
    expect(err.reason).toBe("denied");
  });

  it("remembers an absent stats cube per connection and stops re-asking", async () => {
    const stub = makeClientStub({
      version: 12,
      failWith: V12_MISSING,
      statsCubeExists: false,
    });
    await fetchCubeStats(stub.client, "A").catch(() => undefined);
    await fetchCubeStats(stub.client, "B").catch(() => undefined);
    const err = await fetchCubeStats(stub.client, "C").catch(
      (e: unknown) => e as CubeStatsUnavailableError,
    );
    expect(stub.mdxCalls()).toBe(1);
    expect(stub.probeCalls()).toBe(1);
    expect(err.reason).toBe("absent");
  });

  it("remembers a PRESENT stats cube too — one probe, not one per failure", async () => {
    const stub = makeClientStub({
      version: 11,
      failWith: V11_DE_MISSING,
      statsCubeExists: true,
    });
    for (const c of ["A", "B", "C"])
      await fetchCubeStats(stub.client, c).catch(() => undefined);
    expect(stub.mdxCalls()).toBe(3);
    expect(stub.probeCalls()).toBe(1);
  });

  it("does not memoize a denial (rights can be granted mid-session)", async () => {
    const stub = makeClientStub({ version: 11, failWith: DENIED });
    await fetchCubeStats(stub.client, "A").catch(() => undefined);
    await fetchCubeStats(stub.client, "B").catch(() => undefined);
    expect(stub.mdxCalls()).toBe(2);
  });

  it("still returns statistics on a healthy v11 server", async () => {
    const stub = makeClientStub({ version: 11, stats: HEALTHY_STATS });
    const item = await fetchCubeStats(stub.client, "Sales");
    expect(item.cubeName).toBe("Sales");
    expect(item.memoryTotal).toBe(2048);
    expect(item.fedCells).toBe(400);
    expect(item.feederEfficiency).toBe(4);
  });
});

// ── tm1_get_cube_stats ──────────────────────────────────────────────────────

describe("tm1_get_cube_stats on a server without }Stats* cubes", () => {
  it("reports statsUnavailable (absent) instead of a raw OData error", async () => {
    const fake = makeFakeServer();
    const stub = makeClientStub({
      version: 12,
      failWith: V12_MISSING,
      statsCubeExists: false,
    });
    registerGetCubeStats(fake.server, stub.client);
    const out = parseJson(await fake.getHandler()({ cubeName: "Sales" }));

    expect(out.statsUnavailable).toBeTruthy();
    expect(out.statsUnavailable.reason).toBe("absent");
    expect(out.statsUnavailable.message).toMatch(/v12|Planning Analytics/i);
    expect(out.count).toBe(1);
    // The per-cube error carries the same honest text, never the OData string.
    expect(out.items[0].error).toBe(out.statsUnavailable.message);
    expect(out.items[0].error).not.toMatch(/collection of type/i);
  });

  it("reports a denial as a different, permissions-specific message", async () => {
    const fake = makeFakeServer();
    const stub = makeClientStub({ version: 11, failWith: DENIED });
    registerGetCubeStats(fake.server, stub.client);
    const out = parseJson(await fake.getHandler()({ cubeName: "Sales" }));

    expect(out.statsUnavailable.reason).toBe("denied");
    expect(out.statsUnavailable.message).toMatch(/permission|rights/i);
    expect(out.statsUnavailable.message).not.toMatch(/v12/);
  });

  it("annotates every requested cube once, not once per cube", async () => {
    const fake = makeFakeServer();
    const stub = makeClientStub({
      version: 12,
      failWith: V12_MISSING,
      statsCubeExists: false,
    });
    registerGetCubeStats(fake.server, stub.client);
    const out = parseJson(
      await fake.getHandler()({ cubeNames: ["A", "B", "C"] }),
    );
    expect(out.statsUnavailable.reason).toBe("absent");
    expect(out.count).toBe(3);
    expect(out.items.map((i: { cubeName: string }) => i.cubeName)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  it("returns statistics unchanged on v11 and sets no statsUnavailable", async () => {
    const fake = makeFakeServer();
    const stub = makeClientStub({ version: 11, stats: HEALTHY_STATS });
    registerGetCubeStats(fake.server, stub.client);
    const out = parseJson(await fake.getHandler()({ cubeName: "Sales" }));
    expect(out.statsUnavailable).toBeUndefined();
    expect(out.items[0].memoryTotal).toBe(2048);
    expect(out.items[0].error).toBeUndefined();
  });

  it("keeps a genuine per-cube error per-cube (no server-wide claim)", async () => {
    const fake = makeFakeServer();
    const boom = new TM1Error({
      code: TM1ErrorCode.TM1_ERROR,
      message: "some other failure",
      httpStatus: 500,
    });
    const stub = makeClientStub({ version: 11, failWith: boom });
    registerGetCubeStats(fake.server, stub.client);
    const out = parseJson(await fake.getHandler()({ cubeName: "Sales" }));
    expect(out.statsUnavailable).toBeUndefined();
    expect(out.items[0].error).toContain("some other failure");
  });

  it("a missing USER cube stays a per-cube error on a healthy server", async () => {
    // The regression the probe protects: }StatsByCube is present, so the
    // failure belongs to this one cube — no server-wide verdict, and the
    // German wording is irrelevant to the outcome.
    const fake = makeFakeServer();
    const stub = makeClientStub({
      version: 11,
      failWith: V11_DE_MISSING,
      statsCubeExists: true,
    });
    registerGetCubeStats(fake.server, stub.client);
    const out = parseJson(
      await fake.getHandler()({ cubeName: "ZZ_NO_SUCH_CUBE" }),
    );
    expect(out.statsUnavailable).toBeUndefined();
    expect(out.items[0].error).toContain("Syntaxfehler");
  });
});
