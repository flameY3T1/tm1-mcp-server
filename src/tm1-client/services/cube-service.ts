// Cube domain service. Owns the OData calls under /api/v1/Cubes(...) — listing,
// creating, deleting, rules, clear, unload. Held as `TM1Client.cubes` and
// reachable from there so call sites read like `client.cubes.list()` rather
// than `client.getCubes()`. The flat `getCubes/...` methods on TM1Client remain
// as deprecated wrappers during the migration period (Phase 1 of the
// god-class split — see docs/ARCHITECTURE.md).
import { TM1Error, TM1ErrorCode } from "../../types.js";
import type { Cube, CubeRules, RuleSyntaxError } from "../../types.js";
import type { TM1HttpClient } from "../http.js";

// OData key encoder: double ' per OData literal rules, then percent-encode.
const enc = (s: string): string => encodeURIComponent(String(s).replace(/'/g, "''"));

export class CubeService {
  constructor(private readonly http: TM1HttpClient) {}

  /**
   * List all cubes with their dimension names.
   * GET /api/v1/Cubes?$expand=Dimensions($select=Name)
   *
   * opts.includeRules adds Rules text to the OData $select so we can derive
   * hasRules per cube in a single round-trip (no N+1).
   */
  async list(opts: { includeRules?: boolean } = {}): Promise<Cube[]> {
    const path = opts.includeRules
      ? "/api/v1/Cubes?$select=Name,Rules&$expand=Dimensions($select=Name)"
      : "/api/v1/Cubes?$expand=Dimensions($select=Name)";
    const response = await this.http.request<{
      value: Array<{ Name: string; Rules?: string; Dimensions: Array<{ Name: string }> }>;
    }>("GET", path);
    return response.value.map((c) => {
      const cube: Cube = {
        name: c.Name,
        dimensions: c.Dimensions.map((d) => d.Name),
      };
      if (opts.includeRules) {
        cube.hasRules = !!(c.Rules && c.Rules.trim().length > 0);
      }
      return cube;
    });
  }

  /**
   * Return ordered dimension-name list of a cube.
   * GET /api/v1/Cubes('{name}')?$expand=Dimensions($select=Name)
   */
  async getDimensionNames(cubeName: string): Promise<string[]> {
    const path = `/api/v1/Cubes('${enc(cubeName)}')?$expand=Dimensions($select=Name)`;
    const response = await this.http.request<{ Name: string; Dimensions: Array<{ Name: string }> }>(
      "GET",
      path,
    );
    return response.Dimensions.map((d) => d.Name);
  }

  /**
   * Create a new cube with the given dimensions (in order).
   * POST /api/v1/Cubes
   */
  async create(name: string, dimensionNames: string[]): Promise<void> {
    await this.http.request<void>("POST", "/api/v1/Cubes", {
      Name: name,
      Dimensions: dimensionNames.map((d) => ({
        "@odata.id": `Dimensions('${enc(d)}')`,
      })),
    });
  }

  /**
   * Delete a cube.
   * DELETE /api/v1/Cubes('{name}')
   */
  async delete(name: string): Promise<void> {
    await this.http.request<void>("DELETE", `/api/v1/Cubes('${enc(name)}')`);
  }

  /**
   * Get the rules text for a cube.
   * GET /api/v1/Cubes('{name}')/Rules
   */
  async getRules(cubeName: string): Promise<CubeRules> {
    const path = `/api/v1/Cubes('${enc(cubeName)}')/Rules`;
    // TM1 returns 404/204 both for "cube missing" and "cube has no rules";
    // an empty 200 body (response undefined) also means "no rules". For any
    // of those, probe `/Cubes('X')?$select=Name` to disambiguate so callers
    // get a clear NOT_FOUND for typos instead of a silently-empty rulesText.
    const empty = async (): Promise<CubeRules> => {
      try {
        await this.http.request<{ Name: string }>(
          "GET",
          `/api/v1/Cubes('${enc(cubeName)}')?$select=Name`,
        );
      } catch (probeErr) {
        if (probeErr instanceof TM1Error && probeErr.httpStatus === 404) {
          throw new TM1Error({
            code: TM1ErrorCode.NOT_FOUND,
            message: `Cube '${cubeName}' does not exist.`,
            httpStatus: 404,
            endpoint: `/api/v1/Cubes('${cubeName}')`,
          });
        }
        throw probeErr;
      }
      return { cubeName, rulesText: "", skipCheck: false };
    };

    try {
      // TM1 11.8 returns rules text in the "value" field (not "Text")
      const response = await this.http.request<{
        value?: string;
        Text?: string;
      } | undefined | null>("GET", path);
      const rulesText = response?.value ?? response?.Text ?? "";
      if (rulesText === "") return empty();
      return {
        cubeName,
        rulesText,
        skipCheck: rulesText.toUpperCase().includes("SKIPCHECK"),
      };
    } catch (err) {
      if (err instanceof TM1Error && (err.httpStatus === 404 || err.httpStatus === 204)) {
        return empty();
      }
      throw err;
    }
  }

  /**
   * Bulk-fetch rules for every cube in a single round trip.
   * GET /api/v1/Cubes?$select=Name,Rules
   * Control cubes (Name starts with `}`) excluded unless includeControl=true.
   */
  async getAllRules(includeControl = false): Promise<CubeRules[]> {
    const filter = includeControl ? "" : "&$filter=not startswith(Name,'}')";
    const path = `/api/v1/Cubes?$select=Name,Rules${filter}`;
    const response = await this.http.request<{
      value: Array<{ Name: string; Rules?: string | null }>;
    }>("GET", path);
    return response.value.map((c) => {
      const rulesText = c.Rules ?? "";
      return {
        cubeName: c.Name,
        rulesText,
        skipCheck: rulesText.toUpperCase().includes("SKIPCHECK"),
      };
    });
  }

  /**
   * Create or replace the rules for a cube.
   * TM1 11.8 sets rules by PATCHing the Cube entity ({Rules: "...text..."}).
   * PATCH/POST on /Cubes('{name}')/Rules returns 400 "not supported".
   */
  async updateRules(cubeName: string, rulesText: string, _skipCheck = true): Promise<void> {
    const cubePath = `/api/v1/Cubes('${enc(cubeName)}')`;
    await this.http.request<void>("PATCH", cubePath, { Rules: rulesText });
  }

  /**
   * Validate cube rule syntax without applying. Empty array = valid.
   * POST /api/v1/Cubes('{name}')/tm1.CheckRules with { Rules: "..." }
   */
  async checkRule(cubeName: string, ruleText: string): Promise<RuleSyntaxError[]> {
    const path = `/api/v1/Cubes('${enc(cubeName)}')/tm1.CheckRules`;
    const response = await this.http.request<{
      value?: Array<{ Message: string; LineNumber?: number }>;
    }>("POST", path, { Rules: ruleText });
    return (response.value ?? []).map((e) => ({
      message: e.Message,
      ...(e.LineNumber !== undefined ? { lineNumber: e.LineNumber } : {}),
    }));
  }

  /**
   * Clear cube cells. v12 uses tm1.Clear with tuple selectors; v11 has no
   * tm1.Clear endpoint, so a full clear falls back to an ephemeral TI process
   * with CubeClearData(). Partial clears on v11 throw — caller must use a
   * bedrock TI with `}bedrock.cube.data.clear`.
   * POST /api/v1/Cubes('{cube}')/tm1.Clear
   */
  async clear(cubeName: string, dimensions: string[], tuples: string[][]): Promise<void> {
    if (this.http.tm1Version.startsWith("11")) {
      const isFullClear = dimensions.every((_, i) => (tuples[i] ?? []).length === 0);
      if (!isFullClear) {
        throw new TM1Error({
          code: TM1ErrorCode.UNSUPPORTED_OPERATION,
          message: `Partial clearCube is not supported on TM1 ${this.http.tm1Version} (tm1.Clear endpoint unavailable). Implement a TI process with bedrock '}bedrock.cube.data.clear' or custom CellPutN loop and call via tm1_execute_process.`,
          endpoint: `/api/v1/Cubes('${cubeName}')/tm1.Clear`,
        });
      }
      await this.clearViaTI(cubeName);
      return;
    }

    const body = {
      Tuples: dimensions.map((dim, idx) => ({
        "Hierarchy@odata.bind": `Dimensions('${enc(dim)}')/Hierarchies('${enc(dim)}')`,
        "Members@odata.bind": (tuples[idx] ?? []).map(
          (el) => `Dimensions('${enc(dim)}')/Hierarchies('${enc(dim)}')/Members('${enc(el)}')`,
        ),
      })),
    };
    await this.http.request<void>(
      "POST",
      `/api/v1/Cubes('${enc(cubeName)}')/tm1.Clear`,
      body,
    );
  }

  /**
   * Unload a cube from memory. Forces TM1 to discard the in-memory fed-cell
   * index and reload from disk on next access. Required for feeder corrections
   * to take effect — the fed-cell index is cumulative, so changes to existing
   * feeders only become visible after an unload.
   * POST /api/v1/Cubes('{cube}')/tm1.Unload
   */
  async unload(cubeName: string): Promise<void> {
    await this.http.request<void>(
      "POST",
      `/api/v1/Cubes('${enc(cubeName)}')/tm1.Unload`,
    );
  }

  // 11.x fallback: deploy ephemeral TI with CubeClearData(), execute, delete.
  private async clearViaTI(cubeName: string): Promise<void> {
    // Cap the sanitized cube name so the temp process name stays under TM1's
    // ~256-char process-name limit (prefix + timestamp suffix add ~25 chars).
    const safeName = cubeName.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 200);
    const procName = `}TempClear_${safeName}_${Date.now()}`;
    const safeCube = cubeName.replace(/'/g, "''");
    const prologCode = `CubeClearData('${safeCube}');`;

    await this.http.request<void>("POST", "/api/v1/Processes", {
      Name: procName,
      HasSecurityAccess: false,
      PrologProcedure: prologCode,
      MetadataProcedure: "",
      DataProcedure: "",
      EpilogProcedure: "",
      DataSource: { Type: "None" },
    });

    try {
      await this.http.request<void>(
        "POST",
        `/api/v1/Processes('${enc(procName)}')/tm1.ExecuteWithReturn`,
        {},
      );
    } finally {
      try {
        await this.http.request<void>("DELETE", `/api/v1/Processes('${enc(procName)}')`);
      } catch (cleanupErr) {
        this.http.logger.warn(
          { proc: procName, err: String(cleanupErr) },
          "Failed to delete ephemeral clearCube TI process — manual cleanup needed",
        );
      }
    }
  }
}
