// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "eslint.config.js",
      "scripts/**",
    ],
  },

  // Base JS recommended
  js.configs.recommended,

  // TypeScript: recommended + type-checked (applied to src/ only)
  ...tseslint.configs.recommendedTypeChecked.map((cfg) => ({
    ...cfg,
    files: ["src/**/*.ts"],
  })),

  // Project-specific rules for src/
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── Async correctness (real bugs) ───────────────────────────────
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",

      // ── Import hygiene ───────────────────────────────────────────────
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],

      // ── Noise reduction: downgrade or disable churn-only rules ───────
      // no-explicit-any: warn only — codebase has justified any in adapter layers
      "@typescript-eslint/no-explicit-any": "warn",
      // ── Where `any` actually enters src ──────────────────────────────
      // These were off wholesale. Turned on after counting: src had 25 hits,
      // every one of them the same three doors — JSON.parse, Array.isArray on
      // an unknown (which widens to any[]), and a settled promise's `reason`.
      // Each is a place where unvalidated server data was being read as if it
      // had a type. They stay errors so the next one has to be answered rather
      // than absorbed.
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      // explicit return types — too noisy for this codebase
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      // unused vars: keep as warn (tsc already catches errors)
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // allow require() — not present in this ESM codebase but avoid false positives
      "@typescript-eslint/no-require-imports": "error",
      // restrict-template-expressions can fire on legitimate string coercion
      "@typescript-eslint/restrict-template-expressions": "off",
      // no-base-to-string — off, fires on well-typed code
      "@typescript-eslint/no-base-to-string": "off",
    },
  },

  // TypeScript: recommended + type-checked for tests/. Separate block because
  // tests are type-checked by tsconfig.test.json — the base tsconfig excludes
  // them (it drives the dist build), so the src parser options cannot see them.
  ...tseslint.configs.recommendedTypeChecked.map((cfg) => ({
    ...cfg,
    files: ["tests/**/*.ts"],
  })),

  // Project-specific rules for tests/.
  //
  // The point of linting tests is the async-correctness family: a forgotten
  // `await` in a test does not fail it, it makes it pass for the wrong reason
  // — an assertion that never ran reads exactly like one that did. Everything
  // else is tuned down to keep the gate honest rather than loud.
  {
    files: ["tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.test.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── Async correctness: the reason this block exists ──────────────
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",

      // ── Import hygiene: same as src ──────────────────────────────────
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],

      // ── The unsafe family stays off here, unlike src ─────────────────
      // Counted rather than assumed: with all five on, src had 25 hits and
      // tests had 1219. The asymmetry is structural, not laziness. A test
      // reads its result as `r.json.items[0].error` — the harness types that
      // payload as `any` on purpose, because a tool's response shape is what
      // the test is there to assert, and typing it up front would assert it in
      // the type system instead. The fakes are the same story from the other
      // side: `{...} as unknown as TM1Client` is how a partial stand-in is
      // built. Turning these on would mean a cast per property read, and the
      // shapes are already pinned — by the service contracts, which check the
      // fakes against structures recorded from a live server.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // ── Off for test-specific reasons ────────────────────────────────
      // require-await: a stub that satisfies an async interface without
      // awaiting anything (`async () => FIXTURE`) is the normal shape of a
      // fake, not an oversight. 179 hits, no signal among them.
      "@typescript-eslint/require-await": "off",
      // unbound-method: fires on `expect(obj.method)` and on passing a spy
      // by reference, both intentional in assertions.
      "@typescript-eslint/unbound-method": "off",
    },
  },
);
