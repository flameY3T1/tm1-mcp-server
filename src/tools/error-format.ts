// Centralized MCP error result formatting. Closes audit gaps 5 (actionable
// hints) and 6 (uniform error shape) without per-tool edits — the index.ts
// Proxy invokes these helpers so every tool emits the same JSON shape:
//
//   { code, message, httpStatus?, endpoint?, details?, hint }
//
// formatTm1ErrorResult: wrap a thrown error into the MCP result envelope.
// normalizeErrorResult: rewrite an already-emitted isError result to the
// uniform shape, parsing existing JSON when present and falling back to
// treating plain-text bodies as TM1_ERROR messages.
import { TM1Error, TM1ErrorCode, hintForCode } from "../types.js";
import { maskSecretValues } from "../lib/mask-secrets.js";

interface UniformErrorPayload {
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- TM1ErrorCode | string is intentional: documents known codes while accepting arbitrary strings for forward-compat
  code: TM1ErrorCode | string;
  message: string;
  httpStatus?: number | undefined;
  endpoint?: string | undefined;
  details?: string | undefined;
  cancelled?: boolean | undefined;
  hint: string;
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

const DEFAULT_CODE: TM1ErrorCode = TM1ErrorCode.TM1_ERROR;

// Second net on the error path. classifyHttpError already sanitizes whatever
// TM1 said, but this envelope also carries errors that never went through it —
// a driver message rethrown by a service, a third-party library's text. Those
// reach the client here, so they get the same value-oriented masking.
// Idempotent: masking an already-masked string is a no-op.
function sanitize(payload: UniformErrorPayload): UniformErrorPayload {
  return {
    ...payload,
    message: maskSecretValues(payload.message),
    ...(payload.details !== undefined
      ? { details: maskSecretValues(payload.details) }
      : {}),
  };
}

function payloadFromUnknown(err: unknown): UniformErrorPayload {
  if (err instanceof TM1Error) {
    return sanitize(err.toErrorPayload());
  }
  if (err instanceof Error) {
    return sanitize({
      code: DEFAULT_CODE,
      message: err.message,
      hint: hintForCode(DEFAULT_CODE),
    });
  }
  return sanitize({
    code: DEFAULT_CODE,
    message: String(err),
    hint: hintForCode(DEFAULT_CODE),
  });
}

export function formatTm1ErrorResult(err: unknown): McpToolResult {
  const payload = payloadFromUnknown(err);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

// Re-shape an isError result that came back from a tool's own try/catch.
// Returns the original result unchanged when it's not safe to rewrite
// (no content, non-text content, etc.) so we never mangle good data.
export function normalizeErrorResult(result: McpToolResult): McpToolResult {
  const first = result.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    return result;
  }

  const raw = first.text.trim();
  let parsed: Record<string, unknown> | null = null;
  if (raw.startsWith("{")) {
    try {
      const candidate: unknown = JSON.parse(raw);
      if (
        candidate &&
        typeof candidate === "object" &&
        !Array.isArray(candidate)
      ) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      parsed = null;
    }
  }

  if (parsed) {
    // Already JSON. Add hint if missing; preserve any extra fields the tool
    // attached (e.g. upsert_process attaches partialApply/failedStep).
    const code = (parsed.code as string | undefined) ?? DEFAULT_CODE;
    const enriched = {
      ...parsed,
      code,
      // Payload fields are preserved via the spread — falling back to `raw`
      // here would duplicate the entire JSON body inside `message`.
      message:
        (parsed.message as string | undefined) ??
        "Tool reported an error — see the payload fields for detail.",
      hint: (parsed.hint as string | undefined) ?? hintForCode(code),
    };
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(enriched) }],
    };
  }

  // Plain-text error body — wrap into uniform shape.
  const stripped = raw.replace(/^TM1 error:\s*/i, "");
  const payload: UniformErrorPayload = {
    code: DEFAULT_CODE,
    message: stripped,
    hint: hintForCode(DEFAULT_CODE),
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

// Attach a tool-context hint to any thrown error and rethrow.
// Use to wrap an awaited TM1 call so failures carry a tool-specific
// follow-up suggestion instead of just the generic code-derived hint.
//
// Example:
//   await withToolHint(
//     tm1Client.cubes.setRules(cube, rules),
//     "Validate first with tm1_check_cube_rule before tm1_set_cube_rules.",
//   );
export async function withToolHint<T>(p: Promise<T>, hint: string): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof TM1Error) {
      // A timeout that reports its cancel outcome already says what happened
      // on the server and what to do next; a generic tool hint would hide it.
      if (err.cancelled === undefined) err.hintOverride = hint;
      throw err;
    }
    throw new TM1Error({
      code: DEFAULT_CODE,
      message: err instanceof Error ? err.message : String(err),
      hint,
    });
  }
}

// True when TM1 never said whether it ran the call: no answer at all (timeout,
// lost or refused connection) or a 5xx. Deliberately narrow — an error raised
// before anything was sent (validation, confirm) has neither mark.
export function isOutcomeUnknown(err: unknown): err is TM1Error {
  if (!(err instanceof TM1Error)) return false;
  if (err.httpStatus !== undefined) return err.httpStatus >= 500;
  return (
    err.code === TM1ErrorCode.LOCK_TIMEOUT ||
    err.code === TM1ErrorCode.CONNECTION_FAILED
  );
}

// Recovery hint for an execution whose outcome is unknown. v11 exposes server
// threads, v12 jobs.
export function unknownOutcomeHint(
  version: 11 | 12,
  what: "process" | "chore",
): string {
  const monitor = version === 12 ? "tm1_list_jobs" : "tm1_list_threads";
  const cancel = version === 12 ? "tm1_cancel_job" : "tm1_cancel_thread";
  return `TM1 did not answer — the ${what} was NOT confirmed failed: it may or may not have started and may still be executing. Use ${monitor} to check for it and ${cancel} to stop it, and inspect its results before running it again. Do NOT blindly re-run: that risks a duplicate execution.`;
}

export type { UniformErrorPayload, McpToolResult };
