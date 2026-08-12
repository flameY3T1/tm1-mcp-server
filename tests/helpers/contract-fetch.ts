// Puts a hand-written fetch stub under the wire contracts.
//
// Tests that stub `fetch` invent the payload TM1 would have returned. Nothing
// checked those inventions against a real server, so a fake could carry a key
// TM1 never sends, or a string where TM1 sends a number, and the suite stayed
// green while production read `undefined` off the real response.
//
// `stubContractCheckedFetch(spy)` installs the spy as the global fetch, but
// routes every call through a check first: the request URL decides which
// contract applies, and the stub's response body is validated against it. The
// spy still receives the call, so `fetchSpy.mock.calls` assertions are
// unaffected.
//
// Checking is "subset": a payload may omit keys, since `$select` trims real
// responses too, and a fake that models only the fields under test is
// legitimate. What it may not do is invent a key or change a type.
import { vi } from "vitest";
import {
  endpointKey,
  diffAgainstShape,
  loadContracts,
} from "./wire-contract.js";
import type { FnSpy } from "./spy-types.js";
import { isExcused } from "./contract-exceptions.js";

// Divergences that were reviewed and accepted live in
// tests/fixtures/contract-exceptions.json, loaded via ./contract-exceptions.js
// so every guard shares one reviewed list.

/**
 * Recover a response body without changing what the code under test sees.
 *
 * The fakes in this suite build bodies with `vi.fn().mockResolvedValue(...)`,
 * which can be read any number of times. A real Response cannot — reading it
 * here would leave the caller with a consumed stream — so those are cloned
 * first. A body that refuses to parse (204 fakes reject on `json()`) yields
 * undefined and the call goes unchecked rather than failing.
 */
async function bodyOf(res: unknown): Promise<unknown> {
  if (res === null || typeof res !== "object") return undefined;
  const r = res as Partial<Response> & { json?: () => Promise<unknown> };
  try {
    if (typeof r.clone === "function" && "bodyUsed" in r) {
      return await r.clone().json();
    }
    if (typeof r.json === "function") return await r.json();
    if (typeof r.text === "function") {
      const t = await r.text();
      return t.trim() ? JSON.parse(t) : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Install `spy` as the global fetch with wire-contract checking in front.
 *
 * Responses whose body cannot be recovered without consuming it are skipped —
 * the guard never changes what the test under it observes.
 */
export function stubContractCheckedFetch(spy: FnSpy): void {
  const { endpoints } = loadContracts();

  const guarded = async (url: unknown, init?: { method?: string }) => {
    const res: unknown = await spy(url, init);
    try {
      const href = String(url);
      const path = href.startsWith("http") ? new URL(href).pathname : href;
      const status =
        (res as { status?: number } | null)?.status ??
        ((res as { ok?: boolean } | null)?.ok === false ? 400 : 200);
      const base = endpointKey(init?.method ?? "GET", path);
      const key = status >= 200 && status < 300 ? base : `${base} !${status}`;

      const contract = endpoints[key];
      const body = await bodyOf(res);
      // No contract simply means the recording never covered this endpoint;
      // an unrecorded endpoint is unknown, not wrong.
      if (contract && body !== undefined) {
        const problems = diffAgainstShape(body, contract).filter(
          (p) => !isExcused(key, p),
        );
        if (problems.length > 0) {
          throw new Error(
            `fetch stub does not match the wire contract for "${key}":\n` +
              problems.map((p) => `  - ${p}`).join("\n") +
              `\n\nEither the fake invented something the server never sends — ` +
              `fix the fake — or TM1 does send it and the recording never saw ` +
              `it. In the second case add an entry with its reason to ` +
              `tests/fixtures/contract-exceptions.json, or widen the recording ` +
              `(\`npm run contracts:record\`).`,
          );
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("wire contract"))
        throw err;
      // Anything else here is the guard's own problem, never the test's.
    }
    return res;
  };

  vi.stubGlobal("fetch", guarded);
}
