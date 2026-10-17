/**
 * Component manifest: which `src` file belongs to which component, and which
 * components each one may import. `scripts/check-boundaries.ts` enforces it in
 * CI (node #795).
 *
 * File rules are globs over the file stem: the repo-relative path with its
 * `.ts` / `.mjs` / `.d.ts` extension removed. `*` matches within one path
 * segment, `**` across segments. A file belongs to a component when it matches
 * one of its `files` rules and none of its `exclude` rules; every `src` file
 * must belong to exactly one component.
 *
 * This module imports nothing: it belongs to `core`.
 */

export interface ComponentUnit {
  files: readonly string[];
}

export interface ComponentSpec<Name extends string = string> {
  files: readonly string[];
  exclude?: readonly string[];
  mayImport: readonly Name[];
  /** Absent until the component is relocated; then only these stems may be imported from outside. */
  publicEntries?: readonly string[];
  /** Nested sub-boundaries: a file in one unit may not import a file of another unit. */
  units?: Readonly<Record<string, ComponentUnit>>;
}

export type ComponentManifest<Name extends string = string> = Readonly<Record<Name, ComponentSpec<Name>>>;

export const componentNames = [
  "core",
  "events",
  "memory",
  "purpose",
  "vsa",
  "tools",
  "policy",
  "home",
  "algorithm",
  "router",
  "graph",
  "execution",
  "substrates",
  "migrate",
  "flows",
  "cli",
  "legacy",
] as const;

export type ComponentName = (typeof componentNames)[number];

const substrateUnitNames = ["anthropic-cowork", "claude-code", "codex", "cursor", "dsh", "grok", "pi-dev"] as const;

function substrateUnit(name: string): ComponentUnit {
  return { files: [`src/adapters/${name}/**`, `src/adapters/${name}`, `src/experimental/${name}`] };
}

export const components: ComponentManifest<ComponentName> = {
  core: {
    files: ["src/core/**", "src/components"],
    mayImport: ["legacy"],
    publicEntries: ["src/core/index.ts"],
  },
  events: {
    files: ["src/events/**"],
    mayImport: ["core", "legacy"],
    publicEntries: ["src/events/index.ts"],
  },
  memory: {
    files: ["src/memory/**"],
    mayImport: ["core", "events", "legacy"],
    publicEntries: ["src/memory/index.ts", "src/memory/types.ts"],
  },
  // Typed goal records (soma#784): Soma owns Purpose (docs/boundaries.md).
  purpose: {
    files: ["src/goal-records", "src/goal-reference"],
    mayImport: ["core", "legacy"],
  },
  vsa: {
    files: ["src/vsa/**"],
    publicEntries: ["src/vsa/index.ts", "src/vsa/types.ts"],
    mayImport: ["core", "events", "memory", "purpose", "legacy"],
  },
  tools: {
    files: ["src/tools/**"],
    exclude: ["src/tools/learning/session-harvester", "src/tools/*/cli"],
    publicEntries: [
      "src/tools/index.ts",
      "src/tools/inference/index.ts",
      "src/tools/learning/index.ts",
      "src/tools/relationship/index.ts",
      "src/tools/wisdom/index.ts",
    ],
    mayImport: ["core", "legacy"],
  },
  policy: {
    files: ["src/policy/**"],
    publicEntries: [
      "src/policy/index.ts",
      "src/policy/types.ts",
      // Leaf entries preserve the small home, install and pi.dev import graphs.
      "src/policy/behavior-policy.ts",
      "src/policy/self-healing-doctrine.ts",
      "src/policy/private-roots.ts",
      "src/policy/projection-private-roots.ts",
      "src/policy/policy.ts",
      "src/policy/policy-path-guard.ts",
      "src/policy/policy-targets.ts",
      "src/policy/policy-audit.ts",
      "src/policy/inbound-security.ts",
      "src/policy/runtime-policy.ts",
      "src/policy/tool-policy-guard.ts",
    ],
    mayImport: ["core", "events", "tools", "legacy"],
  },
  home: {
    files: ["src/home/**"],
    // Leaf entries keep type, reference-code and hook-registration consumers
    // from loading the profile, snapshots and resource readers through index.
    publicEntries: [
      "src/home/index.ts",
      "src/home/types.ts",
      "src/home/communication-contract.ts",
      "src/home/lifecycle-registry.ts",
    ],
    mayImport: ["core", "events", "memory", "purpose", "policy", "legacy"],
  },
  algorithm: {
    files: ["src/algorithm/**"],
    // Direct CLI entries preserve the classify import closure without the barrel.
    publicEntries: [
      "src/algorithm/index.ts",
      "src/algorithm/types.ts",
      "src/algorithm/algorithm.ts",
      "src/algorithm/algorithm-store.ts",
      "src/algorithm/algorithm-classifier.ts",
      "src/algorithm/algorithm-reflection-digest.ts",
      "src/algorithm/algorithm-reflection-import.ts",
      "src/algorithm/algorithm-capabilities.ts",
      "src/algorithm/algorithm-provenance.ts",
      "src/algorithm/algorithm-lifecycle.ts",
    ],
    mayImport: ["core", "home", "vsa", "graph", "legacy"],
  },
  router: {
    files: ["src/router/**"],
    publicEntries: ["src/router/index.ts"],
    mayImport: ["core", "algorithm", "legacy"],
  },
  // Node #810 declares a single public entry. Type-only consumers therefore
  // count the full barrel in the static closure, while Bun erases their imports.
  graph: {
    files: ["src/graph/**"],
    publicEntries: ["src/graph/index.ts"],
    mayImport: ["core", "legacy"],
  },
  execution: {
    files: ["src/execution/**"],
    exclude: ["src/execution/algorithm-loop-executor"],
    publicEntries: ["src/execution/index.ts"],
    mayImport: ["core", "legacy"],
  },
  substrates: {
    files: [
      "src/adapters/**",
      "src/experimental/**",
      "src/install-*",
      "src/installation-*",
      "src/projection*",
      "src/skill-projection",
      "src/projected-skill-links",
      "src/home-projection",
      "src/substrate-projection-rewrites",
      "src/bundled-skills",
      "src/bundled-skill-*",
      "src/runtime-artifact",
      "src/doctor-projection-input",
      "src/legacy-skill-prune",
      "src/skill-frontmatter",
      "src/vsa-skill-installer",
      "src/skill-content-*",
    ],
    mayImport: ["core", "events", "memory", "purpose", "vsa", "policy", "home", "algorithm", "router", "execution", "legacy"],
    units: Object.fromEntries(substrateUnitNames.map((name) => [name, substrateUnit(name)])),
  },
  migrate: {
    files: ["src/claude-skills-*", "src/claude-skill-description-rewriter"],
    mayImport: ["core", "substrates", "legacy"],
  },
  flows: {
    files: [
      "src/writeback",
      "src/memory-promotion",
      "src/memory-projection-reproject",
      "src/learning-readback",
      "src/algorithm-vsa-bridge",
      "src/algorithm-vsa-sync",
      "src/lifecycle",
      "src/onboarding",
      "src/home-bootstrap",
      "src/home-migration",
      "src/install",
      "src/result-capture",
      "src/feedback",
      "src/errata",
      "src/errata-classifier",
      "src/run-ledger",
      "src/run-ledger-env",
      "src/goal-sense",
      "src/goal-outline",
      "src/goal-announce",
      "src/goal-sweep",
      "src/goal-propose",
      "src/goal-accept",
      "src/goal-kinds/**",
      "src/tools/learning/session-harvester",
      "src/execution/algorithm-loop-executor",
    ],
    mayImport: [
      "core",
      "events",
      "memory",
      "vsa",
      "purpose",
      "graph",
      "tools",
      "policy",
      "home",
      "algorithm",
      "execution",
      "substrates",
      "migrate",
      "legacy",
    ],
  },
  cli: {
    // `src/tools/*/cli` is CLI glue: only `src/cli/tools.ts` imports it.
    files: ["src/cli", "src/cli-launcher", "src/cli-vsa", "src/cli/**", "src/tools/*/cli"],
    mayImport: componentNames.filter((name) => name !== "cli"),
  },
  // Temporary: the shared spine. Any component may import it and it may import
  // any component, until the final seams node removes it.
  legacy: {
    files: ["src/types", "src/index"],
    mayImport: componentNames.filter((name) => name !== "legacy"),
  },
};
