// Sandbox domain service. Owns the OData calls under /api/v1/Sandboxes(...):
// list, create, publish, discard and delete. Held as `TM1Client.sandboxes`.
//
// A sandbox is a per-user copy-on-write layer over base data. Reads and writes
// address one by adding `!sandbox=<name>` to the cellset request (see
// withSandboxParam in ../../lib/sandbox-policy.ts); this service only manages
// the sandboxes themselves. Which sandbox a tool may touch is decided in the
// tool layer, by TM1_MODE — not here.
import type { TM1HttpClient } from "../http.js";
import type { SandboxInfo } from "../../schemas/sandboxes.js";
import { odataKey } from "./odata-page.js";

interface RawSandbox {
  Name: string;
  IncludeInSandboxDimension?: boolean;
  IsActive?: boolean;
  IsLoaded?: boolean;
  IsQueued?: boolean;
}

const flag = (v: boolean | undefined): boolean | null =>
  typeof v === "boolean" ? v : null;

export class SandboxService {
  constructor(private readonly http: TM1HttpClient) {}

  /**
   * The signed-in user's sandboxes. No $select: the state flags differ between
   * TM1 builds, and a $select naming a missing one fails the whole request.
   * GET /api/v1/Sandboxes
   */
  async list(): Promise<SandboxInfo[]> {
    const res = await this.http.request<{ value: RawSandbox[] }>(
      "GET",
      "/api/v1/Sandboxes",
    );
    return (res.value ?? []).map((s) => ({
      name: s.Name,
      includeInSandboxDimension: flag(s.IncludeInSandboxDimension),
      isActive: flag(s.IsActive),
      isLoaded: flag(s.IsLoaded),
      isQueued: flag(s.IsQueued),
    }));
  }

  /** POST /api/v1/Sandboxes */
  async create(name: string, includeInSandboxDimension = true): Promise<void> {
    await this.http.request<void>("POST", "/api/v1/Sandboxes", {
      Name: name,
      IncludeInSandboxDimension: includeInSandboxDimension,
    });
  }

  /** Merge the sandbox's changes into base data. POST /api/v1/Sandboxes('…')/tm1.Publish */
  async publish(name: string): Promise<void> {
    await this.http.request<void>(
      "POST",
      `/api/v1/Sandboxes('${odataKey(name)}')/tm1.Publish`,
      {},
    );
  }

  /** Empty the sandbox but keep it. POST /api/v1/Sandboxes('…')/tm1.DiscardChanges */
  async discardChanges(name: string): Promise<void> {
    await this.http.request<void>(
      "POST",
      `/api/v1/Sandboxes('${odataKey(name)}')/tm1.DiscardChanges`,
      {},
    );
  }

  /** DELETE /api/v1/Sandboxes('…') */
  async delete(name: string): Promise<void> {
    await this.http.request<void>(
      "DELETE",
      `/api/v1/Sandboxes('${odataKey(name)}')`,
    );
  }
}
