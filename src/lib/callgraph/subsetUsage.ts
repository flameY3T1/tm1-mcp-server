// Pure per-process scan classifying how each subset handle is USED in a process's TI.
// Feeds element usage classification (source / write / zero-out / indeterminate).
// NOT a datasource check — the process datasource lives in dsList and is joined at
// query time in traceDataFlow.

import { buildProcessEnv, resolveExpression, type ProcessEnv } from "./variableEnv.js";
import { splitArgs, extractStringLiteral } from "./referenceIndex.js";
import { classifyAccess } from "./callGraph.js";

export interface ViewUsage {
  view?: string | undefined;
  cube?: string | undefined;
  zeroOut: boolean;
}
export interface SubsetUsage {
  subset: string;
  resolved: boolean;
  views: ViewUsage[];
  loopRead: boolean;
  loopWrite: boolean;
  loopZero: boolean;
}

const CALL_RE = /\b([A-Za-z_]\w*)\s*\(/gi;

function resolveArg(raw: string | undefined, env: ProcessEnv): { value?: string; resolved: boolean } {
  if (raw === undefined) return { resolved: false };
  const lit = extractStringLiteral(raw);
  if (lit !== null) return { value: lit, resolved: true };
  const b = resolveExpression(raw, env);
  if (b.kind === "literal") return { value: b.value, resolved: true };
  return { resolved: false };
}

export function extractSubsetUsage(text: string, env?: ProcessEnv): Map<string, SubsetUsage> {
  const baseEnv = env ?? buildProcessEnv(text, []);
  const usage = new Map<string, SubsetUsage>();
  const viewToSubsets = new Map<string, string[]>(); // lc "cube view" -> subset lc keys
  let synth = 0;

  const getBucket = (subLc: string, subName: string | undefined, resolved: boolean): SubsetUsage => {
    let u = usage.get(subLc);
    if (!u) {
      u = { subset: subName ?? "", resolved, views: [], loopRead: false, loopWrite: false, loopZero: false };
      usage.set(subLc, u);
    }
    if (!resolved) u.resolved = false;
    return u;
  };

  // Process-wide read/write presence (loose loop-body heuristic — see plan note).
  let hasCellRead = false;
  let hasCellWrite = false;
  let hasZeroWrite = false;
  const iteratedSubsets = new Set<string>();

  const lines = text.split("\n");
  for (const line of lines) {
    let m: RegExpExecArray | null;
    CALL_RE.lastIndex = 0;
    while ((m = CALL_RE.exec(line)) !== null) {
      const fn = m[1]!.toLowerCase();
      const open = m.index + m[0].length - 1;
      const argStr = sliceArgs(line, open);
      const args = argStr === null ? [] : splitArgs(argStr);

      if (fn === "viewsubsetassign") {
        const cube = resolveArg(args[0], baseEnv);
        const view = resolveArg(args[1], baseEnv);
        const sub = resolveArg(args[3], baseEnv);
        const subLc = sub.value?.toLowerCase() ?? `__unresolved_${synth++}`;
        const u = getBucket(subLc, sub.value, sub.resolved && view.resolved);
        u.views.push({ view: view.value, cube: cube.value, zeroOut: false });
        if (view.resolved && cube.value !== undefined) {
          const vk = `${cube.value.toLowerCase()} ${view.value!.toLowerCase()}`;
          const arr = viewToSubsets.get(vk) ?? [];
          arr.push(subLc);
          viewToSubsets.set(vk, arr);
        }
      } else if (fn === "viewzeroout") {
        const cube = resolveArg(args[0], baseEnv);
        const view = resolveArg(args[1], baseEnv);
        if (cube.resolved && view.resolved) {
          const vk = `${cube.value!.toLowerCase()} ${view.value!.toLowerCase()}`;
          for (const subLc of viewToSubsets.get(vk) ?? []) {
            const u = usage.get(subLc);
            if (u) for (const v of u.views) {
              if (v.cube?.toLowerCase() === cube.value!.toLowerCase() && v.view?.toLowerCase() === view.value!.toLowerCase()) v.zeroOut = true;
            }
          }
        }
      } else if (fn === "subsetgetelementname" || fn === "subsetgetsize") {
        const sub = resolveArg(args[0], baseEnv);
        if (sub.resolved) iteratedSubsets.add(sub.value!.toLowerCase());
      } else {
        const access = classifyAccess(fn, "process");
        if (access === "read") hasCellRead = true;
        else if (access === "write") {
          hasCellWrite = true;
          if ((fn === "cellputn" || fn === "cellincrementn") && isLiteralZero(args[0])) hasZeroWrite = true;
        }
      }
    }
  }

  // Attribute the process-wide loop read/write to each iterated subset (loose heuristic).
  for (const subLc of iteratedSubsets) {
    const u = getBucket(subLc, subLc, true);
    if (hasCellRead) u.loopRead = true;
    if (hasCellWrite) u.loopWrite = true;
    if (hasZeroWrite) u.loopZero = true;
  }

  return usage;
}

function isLiteralZero(raw: string | undefined): boolean {
  return raw !== undefined && raw.trim() === "0";
}

// Extract the substring between the '(' at openIdx and its matching ')' on the same line.
function sliceArgs(line: string, openIdx: number): string | null {
  let depth = 0;
  for (let i = openIdx; i < line.length; i++) {
    const c = line[i];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return line.slice(openIdx + 1, i); }
  }
  return null;
}
