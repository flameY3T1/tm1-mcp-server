import { describe, it, expect } from "vitest";
import {
  READ_ONLY,
  IDEMPOTENT_WRITE,
  withVersion,
  type Tm1ToolAnnotations,
} from "../../src/tools/annotations.js";
import { ANNOTATION_MAP } from "../../src/tools/annotation-map.js";

describe("R2-21: requiresVersion annotation extension", () => {
  describe("withVersion()", () => {
    it("returns a new annotation with requiresVersion attached", () => {
      const tagged = withVersion(READ_ONLY, "v11");
      expect(tagged.requiresVersion).toBe("v11");
      expect(tagged.readOnlyHint).toBe(true);
    });

    it("does not mutate the base annotation", () => {
      withVersion(READ_ONLY, "v12");
      expect((READ_ONLY as Tm1ToolAnnotations).requiresVersion).toBeUndefined();
    });

    it("preserves all base hints", () => {
      const tagged = withVersion(IDEMPOTENT_WRITE, "v11");
      expect(tagged.readOnlyHint).toBe(false);
      expect(tagged.idempotentHint).toBe(true);
      expect(tagged.destructiveHint).toBe(false);
      expect(tagged.openWorldHint).toBe(true);
    });
  });

  describe("ANNOTATION_MAP version tags", () => {
    const v11OnlyTools = [
      "tm1_check_v12_readiness",
      "tm1_diff_process_with_file",
      "tm1_export_process_to_pro",
      "tm1_import_pro_file",
      "tm1_install_pro_bundle",
      "tm1_save_data",
      "tm1_check_feeders",
      "tm1_trace_feeders",
      "tm1_trace_cell_calculation",
    ];

    it.each(v11OnlyTools)("%s is tagged requiresVersion='v11'", (tool) => {
      const annot = ANNOTATION_MAP[tool];
      expect(annot, `${tool} missing from ANNOTATION_MAP`).toBeDefined();
      expect(annot.requiresVersion).toBe("v11");
    });

    it("untagged tools have no requiresVersion field (version-agnostic)", () => {
      const sample = [
        "tm1_list_cubes",
        "tm1_execute_mdx",
        "tm1_create_dimension",
        "tm1_get_cell_value",
      ];
      for (const tool of sample) {
        expect(ANNOTATION_MAP[tool]?.requiresVersion).toBeUndefined();
      }
    });

    it("requiresVersion field is JSON-serializable (survives wire transport)", () => {
      const annot = ANNOTATION_MAP["tm1_install_pro_bundle"];
      const roundTrip = JSON.parse(JSON.stringify(annot));
      expect(roundTrip.requiresVersion).toBe("v11");
      expect(roundTrip.idempotentHint).toBe(true);
    });
  });
});
