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
] as const;

export type ComponentName = (typeof componentNames)[number];

const substrateUnitNames = ["anthropic-cowork", "claude-code", "codex", "cursor", "dsh", "grok", "pi-dev"] as const;

function substrateUnit(name: string): ComponentUnit {
  return { files: [`src/substrates/adapters/${name}/**`, `src/substrates/adapters/${name}`] };
}

export const components: ComponentManifest<ComponentName> = {
  core: {
    files: ["src/core/**", "src/components"],
    mayImport: [],
    // dir-lock.ts is its own entry, outside index.ts: it imports bun:ffi, and pi loads extensions that import the barrel under Node.
    publicEntries: ["src/core/index.ts", "src/core/types.ts", "src/core/dir-lock.ts"],
  },
  events: {
    files: ["src/events/**"],
    mayImport: ["core"],
    publicEntries: ["src/events/index.ts"],
  },
  memory: {
    files: ["src/memory/**"],
    mayImport: ["core", "events"],
    publicEntries: ["src/memory/index.ts", "src/memory/types.ts"],
  },
  // Typed goal records (soma#784): Soma owns Purpose (docs/boundaries.md).
  purpose: {
    files: ["src/goal-records", "src/goal-reference"],
    mayImport: ["core"],
  },
  vsa: {
    files: ["src/vsa/**"],
    publicEntries: ["src/vsa/index.ts", "src/vsa/types.ts"],
    mayImport: ["core", "events", "memory", "purpose"],
  },
  tools: {
    files: ["src/tools/**"],
    publicEntries: [
      "src/tools/index.ts",
      "src/tools/inference/index.ts",
      "src/tools/learning/index.ts",
      "src/tools/relationship/index.ts",
      "src/tools/wisdom/index.ts",
    ],
    mayImport: ["core"],
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
    mayImport: ["core", "events", "tools"],
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
    mayImport: ["core", "events", "memory", "purpose", "vsa", "policy"],
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
    mayImport: ["core", "home", "vsa", "graph"],
  },
  router: {
    files: ["src/router/**"],
    publicEntries: ["src/router/index.ts"],
    mayImport: ["core", "algorithm"],
  },
  // Node #810 declares a single public entry. Type-only consumers therefore
  // count the full barrel in the static closure, while Bun erases their imports.
  graph: {
    files: ["src/graph/**"],
    publicEntries: ["src/graph/index.ts"],
    mayImport: ["core"],
  },
  execution: {
    files: ["src/execution/**"],
    publicEntries: ["src/execution/index.ts"],
    mayImport: ["core"],
  },
  substrates: {
    // Leaf entries keep shared types, hook/bootstrap and migration consumers off the adapter barrel.
    publicEntries: [
      "src/substrates/index.ts",
      "src/substrates/types.ts",
      "src/substrates/runtime-artifact.ts",
      "src/substrates/adapters/session-env.ts",
      "src/substrates/skill-content-slug.ts",
      "src/substrates/skill-content-normalizer.ts",
      "src/substrates/skill-content-noise.ts",
      "src/substrates/adapters/pi-dev/skill-projection.ts",
    ],
    files: [
      "src/substrates/**",
    ],
    mayImport: ["core", "events", "memory", "purpose", "vsa", "policy", "home", "algorithm", "router", "execution"],
    units: Object.fromEntries(substrateUnitNames.map((name) => [name, substrateUnit(name)])),
  },
  migrate: {
    files: ["src/migrate/**"],
    publicEntries: ["src/migrate/index.ts", "src/migrate/types.ts"],
    mayImport: ["core", "home", "substrates"],
  },
  flows: {
    files: ["src/flows/**"],
    publicEntries: ["src/flows/index.ts", "src/flows/types.ts"],
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
    ],
  },
  cli: {
    files: ["src/cli", "src/cli-launcher", "src/cli/**"],
    mayImport: componentNames.filter((name) => name !== "cli"),
  },
};
