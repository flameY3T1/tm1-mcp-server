// Same guard as contract-fetch.ts, one layer up.
//
// Some tests stub `TM1HttpClient.request` instead of `fetch`. What that method
// resolves to IS the decoded wire body, so the identical contract applies —
// only the interception point differs.
import {
  endpointKey,
  diffAgainstShape,
  loadContracts,
} from "./wire-contract.js";
import { isExcused } from "./contract-exceptions.js";

type RequestFn = (
  method: string,
  path: string,
  ...rest: unknown[]
) => Promise<unknown>;

/**
 * Put a fake `TM1HttpClient` under the contracts by replacing its `request`
 * with a checked one. Mutates and returns the same object, so call sites keep
 * whatever identity or extra fields they rely on.
 */
export function contractCheckedHttp<T>(http: T): T {
  const target = http as { request?: RequestFn };
  if (typeof target.request === "function") {
    target.request = contractCheckedRequest(target.request.bind(target));
  }
  return http;
}

/**
 * Wrap a stubbed `request` so every body it resolves is checked against the
 * recorded contract for that endpoint. Returns a drop-in replacement.
 */
export function contractCheckedRequest(fn: RequestFn): RequestFn {
  const { endpoints } = loadContracts();
  return async (method: string, path: string, ...rest: unknown[]) => {
    const body = await fn(method, path, ...rest);
    if (body === undefined || body === null) return body;
    const key = endpointKey(method, path);
    const contract = endpoints[key];
    if (!contract) return body;
    const problems = diffAgainstShape(body, contract).filter(
      (p) => !isExcused(key, p),
    );
    if (problems.length > 0) {
      throw new Error(
        `http.request stub does not match the wire contract for "${key}":\n` +
          problems.map((p) => `  - ${p}`).join("\n") +
          `\n\nSee tests/fixtures/contract-exceptions.json.`,
      );
    }
    return body;
  };
}
