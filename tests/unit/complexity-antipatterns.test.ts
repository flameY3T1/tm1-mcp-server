import { describe, it, expect } from "vitest";
import {
  lintProcess,
  type Finding,
} from "../../src/lib/complexity/antipatterns.js";
import type { ProcessCodeInput } from "../../src/lib/complexity/process-metrics.js";

/** Build a ProcessCodeInput from partial tabs (unset tabs are empty). */
function code(parts: Partial<ProcessCodeInput>): ProcessCodeInput {
  return { prolog: "", metadata: "", data: "", epilog: "", ...parts };
}

function rules(findings: Finding[]): string[] {
  return findings.map((f) => f.rule);
}

describe("destructive-unguarded", () => {
  it("flags an unconditional CubeClearData as an error", () => {
    const findings = lintProcess(
      "p",
      code({ prolog: `CubeClearData('Sales');` }),
    );
    const hit = findings.find((f) => f.rule === "destructive-unguarded");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("error");
    expect(hit?.tab).toBe("prolog");
    expect(hit?.line).toBe(1);
  });

  it("does not flag a destructive op guarded by an enclosing If", () => {
    const findings = lintProcess(
      "p",
      code({ prolog: `IF(pMode=1);\n  CubeClearData('Sales');\nENDIF;` }),
    );
    expect(rules(findings)).not.toContain("destructive-unguarded");
  });

  it("downgrades to warn when the process name signals a clear/init/zeroout/test proc", () => {
    for (const name of [
      "ZeroOut_Cube",
      "FP_InitImport_TM1",
      "Cube_Clear_All",
      "zzz_Test_Reset",
    ]) {
      const findings = lintProcess(
        name,
        code({ prolog: `CubeClearData(vCube);` }),
      );
      const hit = findings.find((f) => f.rule === "destructive-unguarded");
      expect(hit, name).toBeDefined();
      expect(hit?.severity, name).toBe("warn");
    }
  });

  it("keeps error severity for a normally-named destructive proc", () => {
    const findings = lintProcess(
      "Sales_Import",
      code({ prolog: `CubeClearData(vCube);` }),
    );
    const hit = findings.find((f) => f.rule === "destructive-unguarded");
    expect(hit?.severity).toBe("error");
  });
});

describe("exec-in-loop", () => {
  it("flags ExecuteProcess inside a while as a sync-complexity warning", () => {
    const findings = lintProcess(
      "p",
      code({ data: `WHILE(i<10);\n  ExecuteProcess('Child');\n  i=i+1;\nEND;` }),
    );
    const hit = findings.find((f) => f.rule === "exec-in-loop");
    expect(hit?.severity).toBe("warn");
    expect(hit?.line).toBe(2);
    expect(hit?.hint.toLowerCase()).toContain("sync");
  });

  it("flags RunProcess inside a while with an async timing/persistence hint", () => {
    const findings = lintProcess(
      "p",
      code({ data: `WHILE(i<10);\n  RunProcess('Child');\n  i=i+1;\nEND;` }),
    );
    const hit = findings.find((f) => f.rule === "exec-in-loop");
    expect(hit?.severity).toBe("warn");
    expect(hit?.hint.toLowerCase()).toContain("async");
  });

  it("does not flag ExecuteProcess outside any loop", () => {
    const findings = lintProcess(
      "p",
      code({ prolog: `ExecuteProcess('Child');` }),
    );
    expect(rules(findings)).not.toContain("exec-in-loop");
  });
});

describe("hot-op-in-loop removed", () => {
  it("does not emit hot-op-in-loop (cell writes in a loop are complexity, not an anti-pattern)", () => {
    const findings = lintProcess(
      "p",
      code({ data: `WHILE(i<10);\n  ASCIIOutput('out.txt', n);\n  CellPutN(1, 'c', 'e');\nEND;` }),
    );
    expect(rules(findings)).not.toContain("hot-op-in-loop");
  });
});

/** CellGetN against `cube` with `dims` element args. */
function cellGet(cube: string, dims: number): string {
  const elems = Array.from({ length: dims }, (_, i) => `e${i}`).join(", ");
  return `'${cube}', ${elems}`;
}

describe("cellget-perf", () => {
  it("flags a high-dimensional CellGetN standalone as info", () => {
    const findings = lintProcess(
      "p",
      code({ data: `v = CellGetN(${cellGet("Big", 12)});` }),
    );
    const hit = findings.find((f) => f.rule === "cellget-perf");
    expect(hit?.severity).toBe("info");
    expect(hit?.line).toBe(1);
  });

  it("escalates a high-dimensional CellGetN inside a loop to warn", () => {
    const findings = lintProcess(
      "p",
      code({ data: `WHILE(i<10);\n  v = CellGetN(${cellGet("Big", 12)});\nEND;` }),
    );
    const hit = findings.find((f) => f.rule === "cellget-perf");
    expect(hit?.severity).toBe("warn");
    expect(hit?.line).toBe(2);
  });

  it("does not flag a CellGetN below the dimension threshold", () => {
    const findings = lintProcess(
      "p",
      code({ data: `v = CellGetN(${cellGet("Small", 3)});` }),
    );
    expect(rules(findings)).not.toContain("cellget-perf");
  });

  it("honors a custom cellGetDimThreshold", () => {
    const findings = lintProcess(
      "p",
      code({ data: `v = CellGetN(${cellGet("Mid", 5)});` }),
      { cellGetDimThreshold: 5 },
    );
    expect(rules(findings)).toContain("cellget-perf");
  });
});

describe("dead-assignment", () => {
  it("flags a variable assigned in data tab but never read", () => {
    const findings = lintProcess(
      "p",
      code({ data: `vTemp = 42;\nNVALUE = 1;` }),
    );
    const hit = findings.find((f) => f.rule === "dead-assignment");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("info");
    expect(hit?.snippet).toContain("vTemp");
    expect(hit?.tab).toBe("data");
  });

  it("does not flag a variable that is read in the same tab", () => {
    const findings = lintProcess(
      "p",
      code({ data: `vX = 5;\nNVALUE = vX * 2;` }),
    );
    expect(rules(findings)).not.toContain("dead-assignment");
  });

  it("does not flag a variable assigned in data tab but read in epilog", () => {
    const findings = lintProcess(
      "p",
      code({
        data: `vSum = vSum + 1;`,
        epilog: `ASCIIOutput('out.txt', NumberToString(vSum));`,
      }),
    );
    expect(rules(findings)).not.toContain("dead-assignment");
  });

  it("does not flag a variable assigned in prolog (only data/metadata flagged)", () => {
    const findings = lintProcess(
      "p",
      code({ prolog: `vUnused = 99;` }),
    );
    expect(rules(findings)).not.toContain("dead-assignment");
  });

  it("does not flag a variable assigned in metadata tab that is read in data tab", () => {
    const findings = lintProcess(
      "p",
      code({
        metadata: `vElem = 'Total';`,
        data: `IF(vElem @= 'Total');\n  NVALUE = 0;\nENDIF;`,
      }),
    );
    expect(rules(findings)).not.toContain("dead-assignment");
  });

  it("flags a variable assigned in metadata tab but never read", () => {
    const findings = lintProcess(
      "p",
      code({ metadata: `vDead = 'unused';` }),
    );
    const hit = findings.find((f) => f.rule === "dead-assignment");
    expect(hit?.tab).toBe("metadata");
  });

  it("does not flag NVALUE / SVALUE / VALUE_IS_STRING (implicit TI vars)", () => {
    const findings = lintProcess(
      "p",
      code({ data: `NVALUE = 0;\nSVALUE = '';\nVALUE_IS_STRING = 0;` }),
    );
    expect(rules(findings)).not.toContain("dead-assignment");
  });

  it("does not flag V1..Vn datasource column vars", () => {
    const findings = lintProcess(
      "p",
      code({ data: `V1 = V1;\nV12 = V12;` }),
    );
    expect(rules(findings)).not.toContain("dead-assignment");
  });

  it("does not flag rc = ExecuteProcess (side-effecting RHS)", () => {
    const findings = lintProcess(
      "p",
      code({ data: `rc = ExecuteProcess('Child', 'p', 1);` }),
    );
    expect(rules(findings)).not.toContain("dead-assignment");
  });

  it("treats Expand('%vPath%') as a read of vPath", () => {
    const findings = lintProcess(
      "p",
      code({
        data: `vPath = 'data';\nASCIIOutput(Expand('%vPath%\\out.txt'), SValue);`,
      }),
    );
    expect(rules(findings)).not.toContain("dead-assignment");
  });

  it("respects excludeVarsFromDeadCheck option", () => {
    const findings = lintProcess(
      "p",
      code({ data: `pExcluded = 7;` }),
      { excludeVarsFromDeadCheck: ["pExcluded"] },
    );
    expect(rules(findings)).not.toContain("dead-assignment");
  });

  it("reports dead variable only once even if assigned multiple times", () => {
    const findings = lintProcess(
      "p",
      code({ data: `vX = 1;\nvX = 2;` }),
    );
    const hits = findings.filter((f) => f.rule === "dead-assignment");
    expect(hits.length).toBe(1);
  });

  it("does not flag a loop counter that appears in the WHILE condition", () => {
    const findings = lintProcess(
      "p",
      code({ data: `i = 1;\nWHILE(i <= 10);\n  i = i + 1;\nEND;` }),
    );
    expect(rules(findings)).not.toContain("dead-assignment");
  });
});

describe("hardcoded-path", () => {
  it("flags a hardcoded UNC path literal as a warning", () => {
    const findings = lintProcess(
      "p",
      code({ prolog: `ASCIIOutput('\\\\srv\\share\\out.txt', n);` }),
    );
    const hit = findings.find((f) => f.rule === "hardcoded-path");
    expect(hit?.severity).toBe("warn");
    expect(hit?.line).toBe(1);
  });

  it("flags a hardcoded drive-letter path literal", () => {
    const findings = lintProcess(
      "p",
      code({ prolog: `ASCIIOutput('C:\\temp\\out.txt', n);` }),
    );
    expect(rules(findings)).toContain("hardcoded-path");
  });

  it("does not flag a non-path string literal", () => {
    const findings = lintProcess(
      "p",
      code({ prolog: `ASCIIOutput('out.txt', n);` }),
    );
    expect(rules(findings)).not.toContain("hardcoded-path");
  });
});
