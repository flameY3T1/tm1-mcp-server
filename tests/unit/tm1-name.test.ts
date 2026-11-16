import { describe, it, expect } from "vitest";
import { tm1NameEquals, tm1NameKey } from "../../src/lib/tm1-name.js";
import {
  resolveCellAddress,
  sandboxPosition,
} from "../../src/lib/cell-address.js";

describe("TM1 name identity", () => {
  it("ignores case and spaces", () => {
    expect(tm1NameKey("Total Year")).toBe(tm1NameKey("TOTALYEAR"));
    expect(tm1NameEquals("Cost Center", "costcenter")).toBe(true);
    expect(tm1NameEquals("Cost_Center", "CostCenter")).toBe(false);
  });

  it("lets a cell address name a dimension the way TM1 accepts it", () => {
    const address = resolveCellAddress(
      "zzPlan",
      ["Cost Center", "Measure"],
      ["measure", "costcenter"],
    );
    expect(address.toCubeOrder(["Amount", "CC100"])).toEqual([
      "CC100",
      "Amount",
    ]);
  });

  it("finds the Sandboxes dimension however it is spelled", () => {
    expect(sandboxPosition(["sand boxes", "Measure"])).toBe(0);
    expect(sandboxPosition(["Region", "Measure"])).toBe(-1);
  });
});
