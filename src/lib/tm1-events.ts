// In-process event bus for cross-cutting TM1 events.
//
// Currently emits only `mutation` after any successful non-safe HTTP request
// (POST/PUT/PATCH/DELETE), used by R2-05 resource-subscription notifications
// and as a future hook for cache layers.
//
// Decoupled from the HTTP layer so the MCP-side subscription registry can
// listen without HTTP needing a reference to the MCP server.

import { EventEmitter } from "node:events";

export interface Tm1MutationEvent {
  method: string;
  path: string;
}

interface Tm1Events {
  mutation: (e: Tm1MutationEvent) => void;
}

// Typed event emitter via thin wrapper. Listeners registered for events
// outside this map are silently allowed by Node's EventEmitter but won't
// receive emit calls from this module.
class TypedEmitter extends EventEmitter {
  override on<K extends keyof Tm1Events>(event: K, listener: Tm1Events[K]): this {
    return super.on(event, listener);
  }
  override off<K extends keyof Tm1Events>(event: K, listener: Tm1Events[K]): this {
    return super.off(event, listener);
  }
  override emit<K extends keyof Tm1Events>(
    event: K,
    ...args: Parameters<Tm1Events[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}

export const tm1Events = new TypedEmitter();

// Set a generous listener cap. Subscriptions are server-scoped (one listener
// per running server process), so the default 10 is fine for now; raise only
// if a workload registers many per-resource listeners.
tm1Events.setMaxListeners(20);
