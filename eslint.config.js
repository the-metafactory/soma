// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

// A catch that never reads its error turns every failure into the fallback
// value, so a permission error, a corrupt file and a bug all read as "empty".
// Reviews flagged this fail-open shape in about 25 PRs (#549, #577, #724,
// #725, #856, …). Copies that predate the rule sit in eslint-suppressions.json,
// which may only shrink.
/** @type {import("eslint").Rule.RuleModule} */
export const noDiscardedError = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      discarded:
        "This catch discards its error, so any failure reads as the fallback (fail-open). Bind the error and handle only the case you expect, e.g. `if (isEnoent(error)) return …; throw error;` (isEnoent from src/core/index.ts), or rethrow with `{ cause: error }`. A deliberate swallow is the principal's call: an inline disable or a new suppression fails `bun run check:suppressions` until the principal accepts it. See AGENTS.md \"Enforced rules\".",
    },
  },
  create(context) {
    /** @param {import("estree").Node} owner @param {import("estree").Pattern | null | undefined} param */
    const discards = (owner, param) => {
      if (param == null) return true;
      if (param.type !== "Identifier") return false;
      const variable = context.sourceCode.getDeclaredVariables(owner).find((candidate) => candidate.name === param.name);
      return variable !== undefined && variable.references.length === 0;
    };
    return {
      CatchClause(node) {
        if (discards(node, node.param)) context.report({ node, messageId: "discarded" });
      },
      /** @param {import("estree").CallExpression} node */
      "CallExpression[callee.type='MemberExpression'][callee.property.name='catch']"(node) {
        const handler = node.arguments[0];
        if (handler && (handler.type === "ArrowFunctionExpression" || handler.type === "FunctionExpression") && discards(handler, handler.params[0])) {
          context.report({ node: handler, messageId: "discarded" });
        }
      },
    };
  },
};

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      ".worktrees/**",
      ".tmp-tests/**",
      ".claude/**",
      ".codex/**",
      ".pi/**",
      "eslint.config.js",
      "MEMORY/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-deprecated": "error",
      "@typescript-eslint/no-redundant-type-constituents": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  {
    files: ["src/**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        clearTimeout: "readonly",
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        Worker: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/prefer-nullish-coalescing": "off",
    },
  },

  // Substrate-adapter boundary: codex and pi-dev may not import each other.
  // Access from outside the adapters goes through the substrates component's
  // public entries, which scripts/check-boundaries.ts enforces; the adapter
  // sub-barrels that rule once required are gone (node #816 bans barrels).
  //
  // Implementation note: ESLint flat config does NOT compose `rules` across
  // multiple matching config blocks — the last block's rule definition wins.
  // We therefore scope each rule block by `files:` (not `ignores:`) so that
  // each src/ file is matched by exactly one block, with its own pattern list.
  //
  // Pattern shapes:
  //   - `**/adapters/<sub>/**` matches "./adapters/<sub>/..." from outside adapters/
  //   - `../<sub>/**`           matches sibling import from inside adapters/
  // These two together cover every legal import specifier shape in the repo.
  {
    files: ["src/substrates/adapters/codex/**/*.{ts,mjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/adapters/pi-dev/**", "../pi-dev/**", "../../pi-dev/**", "../../../pi-dev/**"],
              message: "codex must not import pi-dev — the two adapter units stay independent.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/substrates/adapters/pi-dev/**/*.{ts,mjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/adapters/codex/**", "../codex/**", "../../codex/**", "../../../codex/**"],
              message: "pi-dev must not import codex — the two adapter units stay independent.",
            },
          ],
        },
      ],
    },
  },


  {
    files: ["src/**/*.{ts,mjs}"],
    plugins: { soma: { rules: { "no-discarded-error": noDiscardedError } } },
    rules: {
      "soma/no-discarded-error": "error",
    },
  },

  {
    files: ["test/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-empty-function": "off",
    },
  },
);
