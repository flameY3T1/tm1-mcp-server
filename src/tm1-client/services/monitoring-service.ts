// Monitoring domain service. Owns runtime introspection — threads and
// sessions. Read endpoints plus the single mutating action `cancelThread`,
// which interrupts a running operation server-side.
//
// See docs/ARCHITECTURE.md for the layering.
import type { Job, Session, Thread } from "../../types.js";
import type { TM1HttpClient } from "../http.js";

function encKey(s: string): string {
  // Double single-quotes for OData escaping, then percent-encode all URL-unsafe chars
  return encodeURIComponent(String(s).replace(/'/g, "''")).replace(/'/g, "%27");
}

export class MonitoringService {
  constructor(private readonly http: TM1HttpClient) {}

  /**
   * List all active threads on the TM1 server.
   * GET /api/v1/Threads
   */
  async getThreads(): Promise<Thread[]> {
    const response = await this.http.request<{
      value: Array<{
        ID: number;
        Type: number;
        Name: string;
        Context?: string;
        State: string;
        Function: string;
        ObjectName: string;
        ElapsedTime?: string;
      }>;
    }>("GET", "/api/v1/Threads?$select=ID,Type,Name,Context,State,Function,ObjectName,ElapsedTime");
    const typeNames: Record<number, string> = { 1: "User", 2: "System", 4: "Admin", 8: "Chore", 16: "Extern" };
    return response.value.map((t) => ({
      id: t.ID,
      type: typeNames[t.Type] ?? `Type${t.Type}`,
      name: t.Name,
      state: t.State,
      function: t.Function,
      objectName: t.ObjectName,
      elapsedTime: t.ElapsedTime,
      context: t.Context,
    }));
  }

  /**
   * Cancel a running TM1 server thread.
   * POST /api/v1/Threads({id})/tm1.CancelOperation
   */
  async cancelThread(threadId: number): Promise<void> {
    await this.http.request<void>("POST", `/api/v1/Threads(${threadId})/tm1.CancelOperation`, {});
  }

  /**
   * List all active sessions on the TM1 server with associated user and
   * threads. TM1 v11.8 returns ID as number; v12 as string — coerced to
   * string. Numeric Type codes are mapped to symbolic names where known.
   * GET /api/v1/Sessions?$expand=Threads,User($select=Name)
   */
  async getSessions(): Promise<Session[]> {
    const response = await this.http.request<{
      value: Array<{
        ID: string | number;
        Active?: boolean;
        User?: { Name: string };
        Threads?: Array<{
          ID: number;
          Type: number | string;
          Name: string;
          State: string;
          Function: string;
          ObjectName: string;
          ObjectType?: string;
          LockType?: string;
          ElapsedTime?: string;
          WaitTime?: string;
          Info?: string;
        }>;
      }>;
    }>("GET", "/api/v1/Sessions?$expand=Threads,User($select=Name)");
    const typeNames: Record<number, string> = { 1: "User", 2: "System", 4: "Admin", 8: "Chore", 16: "Extern" };
    return response.value.map((s) => ({
      id: String(s.ID),
      user: s.User?.Name ?? "",
      ...(s.Active !== undefined ? { active: s.Active } : {}),
      threads: (s.Threads ?? []).map((t) => ({
        id: t.ID,
        type: typeof t.Type === "number" ? (typeNames[t.Type] ?? `Type${t.Type}`) : (t.Type ?? ""),
        name: t.Name ?? "",
        state: t.State ?? "",
        function: t.Function ?? "",
        objectName: t.ObjectName ?? "",
        ...(t.ObjectType !== undefined ? { objectType: t.ObjectType } : {}),
        ...(t.LockType !== undefined ? { lockType: t.LockType } : {}),
        ...(t.ElapsedTime !== undefined ? { elapsedTime: t.ElapsedTime } : {}),
        ...(t.WaitTime !== undefined ? { waitTime: t.WaitTime } : {}),
        ...(t.Info !== undefined ? { info: t.Info } : {}),
      })),
    }));
  }

  /**
   * List all active jobs on v12 database replica.
   * GET /api/v1/Jobs?$select=ID,Description,State,ElapsedTime,WaitTime&$expand=Session,WaitingOn
   */
  async getJobs(): Promise<Job[]> {
    const response = await this.http.request<{
      value: Array<{
        ID: string;
        Description: string;
        State: string;
        ElapsedTime?: string;
        WaitTime?: string;
        Session?: {
          ID: number;
          Context?: string;
          User?: { Name?: string };
        };
        WaitingOn?: Array<{
          ID: string;
          Description: string;
          State: string;
        }>;
      }>;
    }>(
      "GET",
      "/api/v1/Jobs?$select=ID,Description,State,ElapsedTime,WaitTime&$expand=Session($select=ID,Context;$expand=User($select=Name)),WaitingOn($select=ID,Description,State)",
    );
    return response.value.map((j) => ({
      id: j.ID,
      description: j.Description,
      state: j.State,
      ...(j.ElapsedTime !== undefined ? { elapsedTime: j.ElapsedTime } : {}),
      ...(j.WaitTime !== undefined ? { waitTime: j.WaitTime } : {}),
      ...(j.Session
        ? {
            session: {
              id: String(j.Session.ID),
              ...(j.Session.Context !== undefined ? { context: j.Session.Context } : {}),
              ...(j.Session.User?.Name !== undefined ? { user: j.Session.User.Name } : {}),
            },
          }
        : {}),
      ...(j.WaitingOn
        ? {
            waitingOn: j.WaitingOn.map((w) => ({
              id: w.ID,
              description: w.Description,
              state: w.State,
            })),
          }
        : {}),
    }));
  }

  /**
   * Cancel running v12 job.
   * POST /api/v1/Jobs('{id}')/tm1.Cancel
   */
  async cancelJob(jobId: string): Promise<void> {
    await this.http.request<void>("POST", `/api/v1/Jobs('${encKey(jobId)}')/tm1.Cancel`, {});
  }
}
