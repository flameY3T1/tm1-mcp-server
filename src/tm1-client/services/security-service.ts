// Security domain service. Owns the OData calls under /api/v1/Users(...) and
// /api/v1/Groups(...) — client (user) CRUD and group membership management.
// TM1 11.8 exposes users at `/Users` (not `/Clients`); MCP surface keeps the
// "Client" terminology because that is what TM1 admins use day to day.
//
// See docs/ARCHITECTURE.md for the layering.
import type { Client, ClientCreate, ClientUpdate, Group } from "../../types.js";
import type { TM1HttpClient } from "../http.js";

// OData key encoder: double ' per OData literal rules, then percent-encode.
const enc = (s: string): string => encodeURIComponent(String(s).replace(/'/g, "''"));

export class SecurityService {
  constructor(private readonly http: TM1HttpClient) {}

  /**
   * List TM1 users (clients) with their group memberships.
   * GET /api/v1/Users?$expand=Groups
   */
  async listClients(): Promise<Client[]> {
    const res = await this.http.request<{ value: Client[] }>(
      "GET",
      "/api/v1/Users?$select=Name,FriendlyName,Type,Enabled&$expand=Groups",
    );
    return res.value;
  }

  /**
   * Get a single user (client) with their groups.
   * GET /api/v1/Users('{name}')
   */
  async getClient(name: string): Promise<Client> {
    return this.http.request<Client>(
      "GET",
      `/api/v1/Users('${enc(name)}')?$select=Name,FriendlyName,Type,Enabled&$expand=Groups`,
    );
  }

  /**
   * Create a new user (client). Optionally seeds groups.
   * POST /api/v1/Users
   */
  async createClient(payload: ClientCreate): Promise<void> {
    const body: Record<string, unknown> = {
      Name: payload.name,
    };
    if (payload.password !== undefined) body.Password = payload.password;
    if (payload.friendlyName !== undefined) body.FriendlyName = payload.friendlyName;
    if (payload.groups !== undefined) {
      body["Groups@odata.bind"] = payload.groups.map(
        (g) => `Groups('${enc(g)}')`,
      );
    }
    await this.http.request<void>("POST", "/api/v1/Users", body);
  }

  /**
   * Partial update of a user (password / friendlyName / enabled).
   * PATCH /api/v1/Users('{name}')
   */
  async updateClient(name: string, payload: ClientUpdate): Promise<void> {
    const body: Record<string, unknown> = {};
    if (payload.password !== undefined) body.Password = payload.password;
    if (payload.friendlyName !== undefined) body.FriendlyName = payload.friendlyName;
    if (payload.enabled !== undefined) body.Enabled = payload.enabled;
    await this.http.request<void>(
      "PATCH",
      `/api/v1/Users('${enc(name)}')`,
      body,
    );
  }

  /**
   * Delete a user (client).
   * DELETE /api/v1/Users('{name}')
   */
  async deleteClient(name: string): Promise<void> {
    await this.http.request<void>(
      "DELETE",
      `/api/v1/Users('${enc(name)}')`,
    );
  }

  /**
   * List all security groups with member users.
   * TM1 REST exposes Group members under the `Users` navigation property
   * (NOT `Clients`, despite TM1's user-facing "Client" terminology). Verified
   * on TM1 v11.8 — `$expand=Clients` returns HTTP 400.
   * GET /api/v1/Groups?$expand=Users($select=Name)
   */
  async listGroups(): Promise<Group[]> {
    const res = await this.http.request<{ value: Array<{ Name: string; Users?: Array<{ Name: string }> }> }>(
      "GET",
      "/api/v1/Groups?$expand=Users($select=Name)",
    );
    return res.value.map((g) => ({
      Name: g.Name,
      Clients: g.Users ?? [],
    }));
  }

  /**
   * Assign a user to a group.
   * tm1py pattern: PATCH /Users('x') with Name + Groups@odata.bind.
   */
  async assignClientGroup(clientName: string, groupName: string): Promise<void> {
    await this.http.request<void>(
      "PATCH",
      `/api/v1/Users('${enc(clientName)}')`,
      {
        Name: clientName,
        "Groups@odata.bind": [`Groups('${enc(groupName)}')`],
      },
    );
  }

  /**
   * Remove a user from a group.
   * tm1py pattern: DELETE /Users('x')/Groups?$id=Groups('y').
   */
  async removeClientGroup(clientName: string, groupName: string): Promise<void> {
    await this.http.request<void>(
      "DELETE",
      `/api/v1/Users('${enc(clientName)}')/Groups?$id=Groups('${enc(groupName)}')`,
    );
  }
}
