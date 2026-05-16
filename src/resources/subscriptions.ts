// R2-05: MCP resource subscription registry.
//
// Tracks which `tm1://...` URIs the client has subscribed to and, when an
// upstream mutation event fires, pushes `notifications/resources/updated`
// for the relevant URIs. Bridges the existing HTTP-layer mutation hook
// (tm1Events) into the MCP spec's pull-then-notify shape.
//
// Wiring:
//   index.ts → new SubscriptionRegistry(server, logger) → install()
//   HTTP layer → tm1Events.emit('mutation', { method, path })
//   Registry → server.server.sendResourceUpdated({ uri }) per match
//
// Spec: https://modelcontextprotocol.io/specification (resources/subscribe,
// resources/unsubscribe, notifications/resources/updated).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type pino from "pino";
import { tm1Events, type Tm1MutationEvent } from "../lib/tm1-events.js";

// URIs whose contents are sensitive to *any* mutation. The server-state
// resource aggregates counts across cubes/dims/processes/chores/clients —
// almost any non-safe call can change it.
const STATE_SENSITIVE_URIS = new Set<string>(["tm1://server/state"]);

export class SubscriptionRegistry {
  // URIs the client has asked us to push updates for.
  private readonly subscribed = new Set<string>();
  private mutationListener?: (e: Tm1MutationEvent) => void;

  constructor(
    private readonly server: McpServer,
    private readonly logger: pino.Logger,
  ) {}

  /** Install subscribe/unsubscribe request handlers + mutation listener. */
  install(): void {
    const lowLevel = this.server.server;

    lowLevel.setRequestHandler(SubscribeRequestSchema, async (req) => {
      const uri = req.params.uri;
      this.subscribed.add(uri);
      this.logger.debug({ uri, count: this.subscribed.size }, "Resource subscribed");
      return {};
    });

    lowLevel.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
      const uri = req.params.uri;
      this.subscribed.delete(uri);
      this.logger.debug({ uri, count: this.subscribed.size }, "Resource unsubscribed");
      return {};
    });

    this.mutationListener = (e) => this.onMutation(e);
    tm1Events.on("mutation", this.mutationListener);
  }

  /** Detach listener — used for shutdown / tests. */
  dispose(): void {
    if (this.mutationListener) {
      tm1Events.off("mutation", this.mutationListener);
      this.mutationListener = undefined;
    }
    this.subscribed.clear();
  }

  /** Test introspection only. */
  isSubscribed(uri: string): boolean {
    return this.subscribed.has(uri);
  }

  /** Test introspection only. */
  size(): number {
    return this.subscribed.size;
  }

  private onMutation(_e: Tm1MutationEvent): void {
    // Iterate subscribed URIs and notify those affected by this mutation.
    // Currently only the aggregate state resource is mutation-sensitive;
    // future entries can branch on e.path / e.method for finer-grained
    // notifications (e.g. tm1://process/{name}/code on /Processes mutations).
    for (const uri of this.subscribed) {
      if (!STATE_SENSITIVE_URIS.has(uri)) continue;
      // Fire-and-forget; missing transport (server not connected) throws.
      this.server.server.sendResourceUpdated({ uri }).catch((err) => {
        this.logger.warn({ err, uri }, "sendResourceUpdated failed");
      });
    }
  }
}
