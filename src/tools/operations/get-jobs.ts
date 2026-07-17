import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";
import { FORMAT_SCHEMA, pageResponse, type Column } from "../format.js";

// v12-only: Jobs replace v11 Threads as the "what is running" surface. On a v11
// connection these tools are not registered (thread tools are instead).
export function registerGetJobs(server: McpServer, tm1Client: TM1Client): void {
  if (tm1Client.version !== 12) return;

  server.tool(
    "tm1_list_jobs",
    "List active jobs (Activity) on a TM1 v12 database — the running tasks that replaced v11 threads. Paginated (default 50/page). (v12 only)",
    { ...PAGINATION_SCHEMA, ...FORMAT_SCHEMA },
    async ({ limit, offset, fetchAll, format }) => {
      const jobs = await tm1Client.monitoring.getJobs();
      const page = paginate(jobs, limit, offset, fetchAll);
      type Row = (typeof jobs)[number];
      const columns: Column<Row>[] = [
        { header: "id", get: (j) => j.id },
        { header: "description", get: (j) => j.description },
        { header: "state", get: (j) => j.state },
        { header: "elapsedTime", get: (j) => j.elapsedTime ?? "" },
      ];
      return pageResponse(page, format, { title: "Jobs", columns });
    },
  );

  server.tool(
    "tm1_cancel_job",
    [
      "Cancel a running TM1 v12 job by its ID. Use tm1_list_jobs to find the ID.",
      "Non-idempotent: cancelling a finished job errors. Before: tm1_list_jobs to confirm the job is still running.",
      "(v12 only)",
    ].join(" "),
    {
      jobId: z.string().describe("Job ID to cancel"),
    },
    async ({ jobId }) => {
      await tm1Client.monitoring.cancelJob(jobId);
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, jobId }) }] };
    },
  );
}
