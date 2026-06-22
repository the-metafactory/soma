/**
 * Shared seven-phase Algorithm rendering contract, projected as a
 * `the-algorithm/SKILL.md` by adapters whose substrate renders the
 * Algorithm as text banners (codex, grok). `substrateLabel` is the
 * display name used in the skill metadata and the rendering-contract
 * heading; the contract body is substrate-neutral. Substrates with a
 * richer native surface (pi-dev widgets) keep their own rendering.
 *
 * In home projections this file must be emitted AFTER the portable
 * skill files: when the principal has imported `the-algorithm` as a
 * portable Soma skill, the static contract intentionally overwrites
 * that skill's SKILL.md while the rest of the portable skill
 * (Workflows/, references/) ships through unchanged.
 */
export function renderAlgorithmRenderingContract(substrateLabel: string): string {
  return [
    "---",
    "name: the-algorithm",
    'description: "Use when work should run through Soma Algorithm mode with seven-phase rendering, ISA criteria, verification, and learning capture."',
    "metadata:",
    `  short-description: Soma Algorithm rendering contract for ${substrateLabel}`,
    "---",
    "",
    "# The Algorithm",
    "",
    "Use this skill whenever Soma classifies the prompt as ALGORITHM or the user explicitly asks for the Algorithm, ISA, ideal state, criteria, or verification-first work.",
    "",
    "## Execution Harness",
    "",
    "Start with `Workflows/RunAlgorithm.md`. That workflow is the executable Algorithm contract.",
    "",
    "When the Soma CLI is available, create or update a harness run with `bun run soma algorithm ...` before doing substantial work. The harness is mutable run state; the rendering contract below is only the " +
      substrateLabel +
      "-visible phase display.",
    "",
    "Use `algorithm advance` as the deterministic phase gate. If it rejects a transition, fill the missing capabilities, plan steps, build changes, verification, or learning evidence before trying again.",
    "",
    "Capability selections are binding. Use registered capability names only; after selecting one, record invocation evidence with `algorithm invoke` or remove it with `algorithm remove-capability` before completion.",
    "",
    `## ${substrateLabel} Rendering Contract`,
    "",
    "When entering ALGORITHM mode, emit these banners as you progress through each phase. Stream each phase header BEFORE producing the phase content.",
    "",
    "Use the phase names, emoji headers, Unicode bars, and phase numbering exactly:",
    "",
    "```text",
    "♻︎ Entering the PAI ALGORITHM… (Soma) ═════════════",
    "🗒️ TASK: <task summary>",
    "🎯 INTENT: <intent>",
    "",
    "━━━ 👁️ OBSERVE ━━━ 1/7",
    "━━━ 🧠 THINK ━━━ 2/7",
    "━━━ 📋 PLAN ━━━ 3/7",
    "━━━ 🛠️ BUILD ━━━ 4/7",
    "━━━ ⚡ EXECUTE ━━━ 5/7",
    "━━━ ✅ VERIFY ━━━ 6/7",
    "━━━ 📚 LEARN ━━━ 7/7",
    "━━━ 📃 SUMMARY ━━━ 7/7",
    "```",
    "",
    "## Phase Rules",
    "",
    "- OBSERVE: restate task, current state, ideal state, effort, criteria.",
    "- THINK: name assumptions, tradeoffs, and selected registered capabilities.",
    "- PLAN: list concrete steps mapped to criteria.",
    "- BUILD: describe artifacts being changed or created.",
    "- EXECUTE: run the work and keep status moving.",
    "- VERIFY: report each criterion and evidence.",
    "- LEARN: capture reusable decisions or lessons.",
    "- SUMMARY: close with outcome, verification, and any residual risk.",
    "",
    "## Canonical Example",
    "",
    "```text",
    "♻︎ Entering the PAI ALGORITHM… (Soma) ═════════════",
    "🗒️ TASK: Fix the Codex adapter projection",
    "🎯 INTENT: Make the change verifiable and substrate-portable",
    "",
    "━━━ 👁️ OBSERVE ━━━ 1/7",
    "Current state, goal, and criteria are identified.",
    "",
    "━━━ 🧠 THINK ━━━ 2/7",
    "The adapter boundary and filesystem projection constraints are considered.",
    "",
    "━━━ 📋 PLAN ━━━ 3/7",
    "P1 maps to C1, P2 maps to C2, verification follows implementation.",
    "",
    "━━━ 🛠️ BUILD ━━━ 4/7",
    "Files are edited in the smallest safe scope.",
    "",
    "━━━ ⚡ EXECUTE ━━━ 5/7",
    "Commands and checks are run.",
    "",
    "━━━ ✅ VERIFY ━━━ 6/7",
    "C1: passed — test output or source evidence.",
    "",
    "━━━ 📚 LEARN ━━━ 7/7",
    "The durable lesson is recorded when useful.",
    "",
    "━━━ 📃 SUMMARY ━━━ 7/7",
    "The task is complete, with verification evidence.",
    "```",
  ].join("\n");
}
