// Where a write may land, by TM1_MODE.
//
//   readonly   no write tool is registered, so nothing here is reached.
//   readwrite  a write goes to base data, or to any sandbox the caller names.
//   sandbox    a write MUST name a sandbox, and only one whose name starts with
//              TM1_SANDBOX_PREFIX. Base data is out of reach, and so are the
//              sandboxes of other applications that log in with the same
//              account (a planning app's proposal sandboxes, a user's own
//              what-ifs): TM1 scopes sandboxes per user, not per client, so the
//              prefix is the only line between them and this server.
//
// The prefix is a convention, not ownership: a person who names a sandbox
// "mcp-…" by hand hands it to the server. That is the trade for staying
// stateless — no registry file to keep, lose or share between processes.
import { TM1Error, TM1ErrorCode } from "../types.js";

/** What TM1_SANDBOX_PREFIX may contain. Kept narrow: it is matched case-insensitively. */
export const SANDBOX_PREFIX_PATTERN = /^[A-Za-z0-9._-]+$/;

/** The mode and prefix a policy check needs; TM1Client provides both. */
export interface SandboxPolicyContext {
  readonly mode: "readwrite" | "sandbox" | "readonly";
  readonly sandboxPrefix: string;
}

/**
 * Trim and check a sandbox name supplied by a caller. Returns undefined for an
 * empty or absent name ("base data"). Control characters are refused: the name
 * travels in a URL query parameter and an OData key.
 */
export function cleanSandboxName(name: string | undefined): string | undefined {
  const trimmed = (name ?? "").trim();
  if (trimmed === "") return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: `Sandbox name ${JSON.stringify(trimmed)} contains a control character.`,
    });
  }
  return trimmed;
}

/** True when `name` carries the configured prefix (case-insensitive, as TM1 names are). */
export function isManagedSandbox(
  ctx: SandboxPolicyContext,
  name: string,
): boolean {
  return name.toLowerCase().startsWith(ctx.sandboxPrefix.toLowerCase());
}

/**
 * Refuse, in sandbox mode, a sandbox this server does not manage. In readwrite
 * mode every sandbox is fair game. Used by create, write, discard and delete.
 */
export function requireManagedSandbox(
  ctx: SandboxPolicyContext,
  name: string,
): void {
  if (ctx.mode !== "sandbox" || isManagedSandbox(ctx, name)) return;
  throw new TM1Error({
    code: TM1ErrorCode.PERMISSION_DENIED,
    message: `TM1_MODE=sandbox: "${name}" does not start with "${ctx.sandboxPrefix}", so this server may not create, write, discard or delete it. Nothing was sent.`,
    hint: `Use a sandbox named "${ctx.sandboxPrefix}…" — create one with tm1_create_sandbox. Sandboxes without the prefix belong to other applications or people using the same account.`,
  });
}

/**
 * Resolve where a cell write goes. Returns the sandbox name, or undefined for
 * base data. In sandbox mode a missing sandbox is refused, never defaulted.
 */
export function resolveWriteSandbox(
  ctx: SandboxPolicyContext,
  sandbox: string | undefined,
): string | undefined {
  const name = cleanSandboxName(sandbox);
  if (name === undefined) {
    if (ctx.mode === "sandbox") {
      throw new TM1Error({
        code: TM1ErrorCode.PERMISSION_DENIED,
        message:
          "TM1_MODE=sandbox: a write must name a sandbox; base data is not writable in this mode. Nothing was sent.",
        hint: `Pass sandbox="${ctx.sandboxPrefix}…" (tm1_create_sandbox makes one), then tm1_compare_sandbox to review the change. Publishing into base data needs TM1_MODE=readwrite.`,
      });
    }
    return undefined;
  }
  requireManagedSandbox(ctx, name);
  return name;
}

/**
 * Refuse, in sandbox mode, a write to a control cube (`}CubeSecurity`,
 * `}ElementAttributes_…`, `}ClientGroups` …). TM1 accepts such a write into a
 * sandbox, and publishing the sandbox later carries it into the model — so an
 * agent could stage a rights or metadata change that a review of the data
 * cubes never shows. Measured on TM1 12: `}CubeSecurity` set to WRITE in a
 * sandbox became WRITE in base on publish.
 */
export function requireModelCube(
  ctx: SandboxPolicyContext,
  cubeName: string,
): void {
  if (ctx.mode !== "sandbox" || !cubeName.startsWith("}")) return;
  throw new TM1Error({
    code: TM1ErrorCode.PERMISSION_DENIED,
    message: `TM1_MODE=sandbox: "${cubeName}" is a control cube; security, attributes and other model metadata are not writable in this mode, not even into a sandbox. Nothing was sent.`,
    hint: "Write data cubes only. Changes to control cubes need TM1_MODE=readwrite, where they are visible as what they are.",
  });
}

/** Append TM1's `!sandbox` query parameter to a REST path, if a sandbox is set. */
export function withSandboxParam(path: string, sandbox?: string): string {
  if (sandbox === undefined) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}!sandbox=${encodeURIComponent(sandbox)}`;
}
