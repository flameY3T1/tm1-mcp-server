// Records what each service METHOD returns, alongside the wire recording.
//
// The wire recorder sees HTTP; this sees the layer above it, which is where
// the client-level fakes in the unit suite plug in. Both run off the same live
// traffic, so one recording pass pins both layers.
//
// Structure only — same rule as the wire contracts, so nothing model-specific
// is captured.
import { appendFileSync } from "node:fs";
import { shapeOf } from "../helpers/wire-contract.js";
import { SERVICE_NAMES } from "../helpers/service-contract.js";
import { SERVICE_SPOOL } from "./contract-mode.js";

/**
 * Wrap a live TM1Client so every service method call appends the shape of its
 * result to the spool. Returns a stand-in that behaves identically.
 */
export function recordingClient<T extends object>(client: T): T {
  return new Proxy(client, {
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

          return (...args: unknown[]) => {
            const out = (fn as (...a: unknown[]) => unknown).apply(svc, args);
            const note = (result: unknown) => {
              try {
                if (result !== undefined && result !== null) {
                  appendFileSync(
                    SERVICE_SPOOL,
                    JSON.stringify({ key, shape: shapeOf(result) }) + "\n",
                  );
                }
              } catch {
                // Recording must never break the run it observes.
              }
              return result;
            };
            return out instanceof Promise ? out.then(note) : note(out);
          };
        },
      });
    },
  });
}
