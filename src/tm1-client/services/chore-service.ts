// Chore domain service. Owns the OData calls under /api/v1/Chores(...) —
// listing, scheduling toggle, immediate execution, create/update/delete.
//
// See docs/ARCHITECTURE.md for the layering.
import type { Chore, ChoreCreate } from "../../types.js";
import type { RequestOptions, TM1HttpClient } from "../http.js";

const enc = encodeURIComponent;

function frequencyDuration(f: ChoreCreate["frequency"]): string {
  return `P${f.days}DT${String(f.hours).padStart(2, "0")}H${String(f.minutes).padStart(2, "0")}M${String(f.seconds).padStart(2, "0")}S`;
}

export class ChoreService {
  constructor(private readonly http: TM1HttpClient) {}

  /**
   * List all chores with their tasks (process + parameters per step).
   * GET /api/v1/Chores?$expand=Tasks($expand=Process($select=Name))
   */
  async list(): Promise<Chore[]> {
    // Expand Process inside Tasks — without it, Task.Process is omitted and the map
    // below sees undefined for every task.
    const response = await this.http.request<{
      value: Array<{
        Name: string;
        Active: boolean;
        StartTime: string;
        DSTSensitive: boolean;
        Frequency: string;
        Tasks?: Array<{
          Step: number;
          Parameters?: Array<{ Name: string; Value: string | number }>;
          Process?: { Name: string };
        }>;
      }>;
    }>("GET", "/api/v1/Chores?$expand=Tasks($expand=Process($select=Name))");

    return response.value.map((ch) => ({
      name: ch.Name,
      active: ch.Active,
      startTime: ch.StartTime,
      frequency: ch.Frequency,
      processes: (ch.Tasks ?? []).map((t) => ({
        name: t.Process?.Name ?? "<unknown>",
        parameters: Object.fromEntries(
          (t.Parameters ?? []).map((p) => [p.Name, p.Value]),
        ),
      })),
    }));
  }

  /**
   * Activate or deactivate a chore.
   * PATCH /api/v1/Chores('{name}') with { Active: bool }
   */
  async toggleActive(choreName: string, active: boolean): Promise<void> {
    const path = `/api/v1/Chores('${enc(choreName)}')`;
    await this.http.request<void>("PATCH", path, { Active: active });
  }

  /**
   * Execute a chore immediately (bypass its schedule). opts.timeoutMs
   * overrides the 30s default for chores that run long TI chains.
   * POST /api/v1/Chores('{name}')/tm1.Execute
   */
  async execute(choreName: string, opts?: RequestOptions): Promise<void> {
    const path = `/api/v1/Chores('${enc(choreName)}')/tm1.Execute`;
    await this.http.request<void>("POST", path, {}, opts);
  }

  /**
   * Create a new chore.
   * POST /api/v1/Chores
   */
  async create(chore: ChoreCreate): Promise<void> {
    const body = {
      Name: chore.name,
      StartTime: chore.startTime,
      DSTSensitive: chore.dstSensitive,
      Active: chore.active,
      ExecutionMode: chore.executionMode,
      Frequency: frequencyDuration(chore.frequency),
      Tasks: chore.steps.map((step, idx) => ({
        Step: idx,
        "Process@odata.bind": `Processes('${enc(step.process)}')`,
        Parameters: step.parameters.map((p) => ({ Name: p.name, Value: p.value })),
      })),
    };
    await this.http.request<void>("POST", "/api/v1/Chores", body);
  }

  /**
   * Update an existing chore (partial update).
   * PATCH /api/v1/Chores('{name}')
   */
  async update(
    choreName: string,
    updates: {
      startTime?: string | undefined;
      active?: boolean | undefined;
      dstSensitive?: boolean | undefined;
      executionMode?: "SingleCommit" | "MultipleCommit" | undefined;
      frequency?: ChoreCreate["frequency"] | undefined;
      steps?: ChoreCreate["steps"] | undefined;
    },
  ): Promise<void> {
    const path = `/api/v1/Chores('${enc(choreName)}')`;
    const body: Record<string, unknown> = {};
    if (updates.startTime !== undefined) body.StartTime = updates.startTime;
    if (updates.active !== undefined) body.Active = updates.active;
    if (updates.dstSensitive !== undefined) body.DSTSensitive = updates.dstSensitive;
    if (updates.executionMode !== undefined) body.ExecutionMode = updates.executionMode;
    if (updates.frequency !== undefined) {
      body.Frequency = frequencyDuration(updates.frequency);
    }
    if (updates.steps !== undefined) {
      body.Tasks = updates.steps.map((step, idx) => ({
        Step: idx,
        "Process@odata.bind": `Processes('${enc(step.process)}')`,
        Parameters: step.parameters.map((p) => ({ Name: p.name, Value: p.value })),
      }));
    }
    await this.http.request<void>("PATCH", path, body);
  }

  /**
   * Delete a chore.
   * DELETE /api/v1/Chores('{name}')
   */
  async delete(choreName: string): Promise<void> {
    await this.http.request<void>("DELETE", `/api/v1/Chores('${enc(choreName)}')`);
  }
}
