/** Static, documentation-grounded parts available to a missing-kind build.
 * Capabilities describe documented contracts, never local installation state.
 */
export const goalInfrastructure = [
  {
    id: "reflex",
    repo: "the-metafactory/reflex",
    capabilities: [
      "Evaluate Activation Blueprints against schedule, manual, bus or HTTP Impulses.",
      "Apply approval policy, cooldown, run lock and idempotency guards before emitting an Activation Event.",
    ],
    extension_point: "Activation Blueprint in reflex.yaml or the central activations directory; target an Execution Blueprint without orchestrating its steps.",
    source: "docs/design-reflex-v0.md",
  },
  {
    id: "pulse",
    repo: "the-metafactory/pulse",
    capabilities: [
      "Execute dependency trees, capability-injected actions, pipelines and flows.",
      "Connect inline, file, RSS or custom sources to pipelines and file, stdout, webhook or custom destinations.",
      "Emit one execution.run.finished envelope per top-level run when configured.",
    ],
    extension_point: "Register tree runners or define actions, pipelines and flows with injected capabilities.",
    source: "README.md",
  },
  {
    id: "cortex",
    repo: "the-metafactory/cortex",
    capabilities: [
      "Dispatch supervised work to local substrate sessions through policy gates.",
      "Present bus events on principal-facing collaboration surfaces.",
    ],
    extension_point: "Surface adapters and bus event consumers; consume Myelin contracts at the collaboration boundary.",
    source: "docs/architecture.md",
  },
  {
    id: "myelin",
    repo: "the-metafactory/myelin",
    capabilities: [
      "Validate and encode envelopes with sovereignty metadata and verifiable identity.",
      "Publish, subscribe and request/reply through abstract transport contracts.",
      "Spool envelopes through an outbox and replay failed sends.",
    ],
    extension_point: "Envelope builders and abstract Transport interfaces; keep application event vocabulary in its owning component.",
    source: "docs/architecture.md",
  },
  {
    id: "soma-goal-kinds",
    repo: "the-metafactory/soma",
    capabilities: [
      "Describe sensor and mechanism kinds with Zod params, private resource types, runner command, Reflex target and schedule defaults.",
      "Validate private goal proposals and stage activations on acceptance; sensors define state rules.",
    ],
    extension_point: "Add a kind module to src/goal-kinds and register it in src/goal-kinds/registry.ts; extend the goal command for its runner.",
    source: "README.md",
  },
] as const;

/** JSON-safe snapshot alongside listGoalKinds; no private data or discovery. */
export function listGoalInfrastructure() {
  return goalInfrastructure.map((component) => ({ ...component, capabilities: [...component.capabilities] }));
}
