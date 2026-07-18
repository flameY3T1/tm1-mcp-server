import { TM1Error, type ViewDefinition, type Subset } from "../../types.js";
import type { DataSourceEntry } from "./dataFlow.js";
import { elementKey } from "./referenceIndex.js";
import { extractMdxMemberRefs } from "./mdxMembers.js";
import { rethrowIfSystemic } from "../../tm1-client/services/fallback.js";

export type MembershipVia =
  | "view-mdx"
  | "view-native-title"
  | "view-native-expr"
  | "subset-static"
  | "subset-mdx";

export interface DatasourceMembership {
  /** elementKey(dim, element) → processes that reach it through a datasource object. */
  byElement: Map<string, Array<{ process: string; via: MembershipVia }>>;
  /** process → computed MDX selectors encountered (Bucket C boundary; element identity not literal). */
  computedByProcess: Map<string, Set<string>>;
  /** per-object fetch failures (non-systemic); systemic errors are re-thrown. */
  fetchErrors: Array<{ process: string; object: string; message: string }>;
}

export interface MembershipDeps {
  getViewDefinition(cube: string, view: string): Promise<ViewDefinition>;
  getSubset(dimension: string, hierarchy: string, subset: string): Promise<Subset>;
}

export async function buildDatasourceMembership(
  deps: MembershipDeps,
  dsList: DataSourceEntry[],
): Promise<DatasourceMembership> {
  const byElement = new Map<string, Array<{ process: string; via: MembershipVia }>>();
  const computedByProcess = new Map<string, Set<string>>();
  const fetchErrors: DatasourceMembership["fetchErrors"] = [];

  const addMember = (process: string, dim: string, el: string, via: MembershipVia) => {
    const k = elementKey(dim, el);
    const arr = byElement.get(k) ?? [];
    if (!arr.some((e) => e.process === process && e.via === via)) arr.push({ process, via });
    byElement.set(k, arr);
  };
  const addComputed = (process: string, names: string[]) => {
    if (names.length === 0) return;
    const set = computedByProcess.get(process) ?? new Set<string>();
    for (const n of names) set.add(n);
    computedByProcess.set(process, set);
  };
  const addMdx = (process: string, mdx: string, via: MembershipVia) => {
    const { members, computedSelectors } = extractMdxMemberRefs(mdx);
    for (const ref of members) addMember(process, ref.dimension, ref.element, via);
    addComputed(process, computedSelectors);
  };
  const applySubset = (process: string, sub: Subset) => {
    if (sub.elements.length > 0) {
      for (const el of sub.elements) addMember(process, sub.dimensionName, el, "subset-static");
    } else if (sub.expression) {
      addMdx(process, sub.expression, "subset-mdx");
    }
  };

  for (const ds of dsList) {
    try {
      if (ds.type === "TM1CubeView" && ds.sourceName && ds.view) {
        const def = await deps.getViewDefinition(ds.sourceName, ds.view);
        if (def.type === "MDX" && def.mdx) {
          addMdx(ds.name, def.mdx, "view-mdx");
        } else if (def.type === "Native" && def.native) {
          const axes = [...def.native.titles, ...def.native.columns, ...def.native.rows];
          for (const ax of axes) {
            const selected = (ax as { selectedElement?: string }).selectedElement;
            if (selected && ax.dimensionName) {
              addMember(ds.name, ax.dimensionName, selected, "view-native-title");
            }
            if (ax.expression) {
              addMdx(ds.name, ax.expression, "view-native-expr");
            } else if (ax.subsetName && ax.dimensionName) {
              const sub = await deps.getSubset(ax.dimensionName, ax.hierarchyName ?? ax.dimensionName, ax.subsetName);
              applySubset(ds.name, sub);
            }
          }
        }
      } else if (ds.type === "TM1DimensionSubset" && ds.subset && ds.sourceName) {
        const dim = ds.sourceName; // dataSourceNameForServer — the dimension (verify live, Task 4)
        const sub = await deps.getSubset(dim, dim, ds.subset);
        applySubset(ds.name, sub);
      }
    } catch (e) {
      // rethrowIfSystemic classifies AUTH_FAILED/CONNECTION_FAILED/LOCK_TIMEOUT
      // TM1Errors as systemic (must propagate) and returns for expected
      // handleable TM1Errors (e.g. NOT_FOUND). It also rethrows any
      // non-TM1Error by design (fallback.ts: "programming errors, unexpected
      // throws" must never be swallowed by generic REST-fallback call sites).
      // Here the per-object fetch loop's contract is broader: ANY per-object
      // failure (TM1Error or not) is recorded, not thrown — only genuinely
      // systemic TM1Errors propagate. So only route TM1Error through the
      // shared systemic guard; non-TM1Error falls straight to fetchErrors.
      if (e instanceof TM1Error) rethrowIfSystemic(e);
      const object =
        ds.type === "TM1CubeView"
          ? `view ${ds.sourceName}/${ds.view}`
          : `subset ${ds.sourceName}/${ds.subset}`;
      fetchErrors.push({ process: ds.name, object, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return { byElement, computedByProcess, fetchErrors };
}
