// Contracts one layer above the wire: what a service METHOD returns.
//
// Nineteen test files fake TM1 at the client level — `{ cubes: { list: async
// () => [...] } } as unknown as TM1Client` — and hand the tool a ready-made
// domain object. No HTTP happens, so the wire contracts cannot see them, and
// nothing checked that the object a fake hands over resembles what the real
// service produces. A tool tested against `{ name, dimensions }` keeps passing
// after the service starts returning `{ name, dimensionNames }`.
//
// The fix mirrors the wire contracts one level up: record the shape of every
// service method's return value during a live run, then check the fakes
// against it. Recording is structure-only, so no model names are captured.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { diffAgainstShape, type Shape } from "./wire-contract.js";
import { isExcused } from "./contract-exceptions.js";

export interface ServiceContractFile {
  recordedAgainst: string[];
  recordedAt: string;
  /** Keyed `<service>.<method>`, e.g. `cubes.list`. */
  methods: Record<string, Shape>;
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixtures", "service-contracts.json");

let cached: ServiceContractFile | undefined;

export function loadServiceContracts(): ServiceContractFile {
  cached ??= JSON.parse(readFileSync(FIXTURE, "utf8")) as ServiceContractFile;
  return cached;
}

/** Service properties on TM1Client that a fake may stand in for. */
export const SERVICE_NAMES = [
  "batch",
  "cubes",
  "dimensions",
  "hierarchies",
  "cells",
  "views",
  "subsets",
  "elements",
  "processes",
  "chores",
  "security",
  "server",
  "monitoring",
  "files",
] as const;

/**
 * Wrap a fake TM1Client so each service method's return value is checked
 * against the recorded shape for that method.
 *
 * Subset semantics, as on the wire: a fake may return only the fields the
 * tool under test reads. What it may not do is return a field the real
 * service never produces, or the wrong type for one it does.
 *
 * Methods with no recorded contract pass untouched — the live suite does not
 * reach every method, and an unrecorded method is unknown, not wrong.
 */
export function contractCheckedClient<T extends object>(fake: T): T {
  const { methods } = loadServiceContracts();

  return new Proxy(fake, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      const service = String(prop);
      if (
        !SERVICE_NAMES.includes(service as (typeof SERVICE_NAMES)[number]) ||
        value === null ||
        typeof value !== "object"
      ) {
        return value;
      }

      return new Proxy(value as Record<string, unknown>, {
        get(svc, methodProp, svcReceiver) {
          const fn = Reflect.get(svc, methodProp, svcReceiver) as unknown;
          if (typeof fn !== "function") return fn;
          const key = `${service}.${String(methodProp)}`;
          const contract = methods[key];
          if (!contract) return fn;

          return (...args: unknown[]) => {
            const out = (fn as (...a: unknown[]) => unknown).apply(svc, args);
            const check = (result: unknown) => {
              if (result === undefined || result === null) return result;
              const problems = diffAgainstShape(result, contract).filter(
                (p) => !isExcused(key, p),
              );
              if (problems.length > 0) {
                throw new Error(
                  `fake ${key}() does not match the recorded service contract:\n` +
                    problems.map((p) => `  - ${p}`).join("\n") +
                    `\n\nEither the fake returns something the real service ` +
                    `never produces — fix the fake — or the service does and ` +
                    `the recording never saw it, in which case add a reviewed ` +
                    `entry to tests/fixtures/contract-exceptions.json.`,
                );
              }
              return result;
            };
            return out instanceof Promise ? out.then(check) : check(out);
          };
        },
      });
    },
  });
}
