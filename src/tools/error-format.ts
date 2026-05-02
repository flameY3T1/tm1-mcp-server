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

interface UniformErrorPayload {
  code: TM1ErrorCode | string;
  message: string;
  httpStatus?: number;
  endpoint?: string;
  details?: string;
  hint: string;
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

const DEFAULT_CODE: TM1ErrorCode = TM1ErrorCode.TM1_ERROR;

function payloadFromUnknown(err: unknown): UniformErrorPayload {
  if (err instanceof TM1Error) {
    return err.toErrorPayload();
  }
  if (err instanceof Error) {
    return {
      code: DEFAULT_CODE,
      message: err.message,
      hint: hintForCode(DEFAULT_CODE),
    };
  }
  return {
    code: DEFAULT_CODE,
    message: String(err),
    hint: hintForCode(DEFAULT_CODE),
  };
}

export function formatTm1ErrorResult(err: unknown): McpToolResult {
  const payload = payloadFromUnknown(err);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
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
      const candidate = JSON.parse(raw);
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
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
      message: (parsed.message as string | undefined) ?? raw,
      hint: (parsed.hint as string | undefined) ?? hintForCode(code),
    };
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(enriched, null, 2) }],
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
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export type { UniformErrorPayload, McpToolResult };
