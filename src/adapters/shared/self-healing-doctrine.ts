/**
 * SelfHealing doctrine (soma#459) — the SINGLE source of truth for the
 * self-healing advisory lines projected into every substrate's policy
 * projection. `policy/self-healing.md` is the human-readable mirror of this
 * module; the strings here are what actually project, so the module — not the
 * markdown — is authoritative for what a substrate sees.
 *
 * The doctrine is ADVICE ON WHERE A FIX SHOULD LAND, not authority to apply it.
 * This is soma's deliberate divergence from LifeOS's `RULES/SelfHealing.md`,
 * which lets the model auto-apply the fix at confidence. soma must NOT — per
 * #429 ("no autonomous schema mutation; proposals only, principal-gated apply")
 * and #375. Any mutation of principal-trust surfaces still requires the existing
 * `--principal-authority` governance. This doctrine steers routing; the existing
 * governance gates the write.
 *
 * One source, N projections: adapters merge `SELF_HEALING_DOCTRINE_ADVISORY`
 * into their `renderPolicyProjection` advisory list. No adapter re-states the
 * rule text — a drift test asserts the projected lines originate here.
 */

/**
 * One row of the signal -> structural-home routing table: a recurring signal
 * and the structural home a fix for it should be routed to (instead of an inert
 * note). Kept structured so the advisory lines render from a single source
 * array rather than duplicated prose.
 */
export interface SelfHealingRoute {
  /** The recurring signal that should trigger a structural fix. */
  readonly signal: string;
  /** Where a fix for that signal should structurally live. */
  readonly home: string;
}

/** Title line — the doctrine's one-sentence framing (LifeOS: "fix the system, not your notes"). */
export const SELF_HEALING_DOCTRINE_TITLE =
  "SelfHealing doctrine (soma#459): when a miss recurs, encode the fix as structure, not an inert note.";

/**
 * The signal -> structural-home routing table (soma#459). Recurring signals map
 * to the structural home a fix should land in. This is the single array every
 * projection renders from.
 */
export const SELF_HEALING_ROUTES: readonly SelfHealingRoute[] = [
  {
    signal: "recurring preference or correction",
    home: "a projected policy rule (#314) or a memory note with a recall-trigger",
  },
  {
    signal: "recurring process miss",
    home: "an Algorithm/VSA criterion or a deterministic nudge",
  },
  {
    signal: "broken capability or projected artifact",
    home: "a projection self-repair pass or a `soma doctor` fix",
  },
  {
    signal: "recurring code or test failure",
    home: "a test-obligation rule (#314 rule 4)",
  },
];

/** Render one routing-table row to its advisory line. */
export function renderSelfHealingRoute(route: SelfHealingRoute): string {
  return `Route ${route.signal} -> ${route.home}.`;
}

/**
 * Preamble advisory lines: the framing plus the governance guardrail that
 * distinguishes soma from LifeOS (advice-to-route, not authority-to-apply).
 */
export const SELF_HEALING_DOCTRINE_PREAMBLE: readonly string[] = [
  SELF_HEALING_DOCTRINE_TITLE,
  "This is advice on WHERE a fix should land, not authority to apply it: any write to " +
    "principal-trust surfaces still requires `--principal-authority` governance (soma's " +
    "deliberate divergence from LifeOS auto-apply — #429/#375). Proposals only; principal-gated apply.",
];

/**
 * The complete SelfHealing advisory block adapters merge into their
 * `renderPolicyProjection` advisory list: preamble first, then one line per
 * routing-table row. `readonly string[]` so it slots straight into the advisory
 * parameter with a spread. This constant is the drift-test anchor — the
 * projected policy must contain exactly these lines and no adapter may restate
 * them.
 */
export const SELF_HEALING_DOCTRINE_ADVISORY: readonly string[] = [
  ...SELF_HEALING_DOCTRINE_PREAMBLE,
  ...SELF_HEALING_ROUTES.map(renderSelfHealingRoute),
];
