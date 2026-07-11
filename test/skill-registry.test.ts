import { describe, expect, test } from "bun:test";
import {
  SKILL_REGISTRY_LINE_BUDGET,
  extractAntiTriggers,
  extractUseWhenTriggers,
  leadClause,
  renderSkillRegistryEntry,
  truncateAtWordBoundary,
} from "../src/adapters/shared/skill-registry";
import { renderSkills } from "../src/adapters/shared";
import type { SomaSkill } from "../src/types";
import { portableProjectionInput } from "./fixtures";

/**
 * soma#371 — the compact skill registry replaces `## <name>` full-body
 * entries (Path/Triggers on their own lines, full descriptions) with a
 * tight per-skill entry so the eager catalog projection stops crowding out
 * routing signal. These tests pin the extraction helpers (pure, unit-
 * tested per the issue's explicit ask) and the overall line budget.
 */

describe("extractAntiTriggers", () => {
  test("extracts a NOT FOR clause up to the sentence boundary", () => {
    const description =
      "Headless browser automation via agent-browser. USE WHEN batch screenshots, dev server tests. " +
      "NOT FOR deploy verification or real-Chrome UI confirmation (use Interceptor), simple single-URL fetches (use WebFetch).";
    expect(extractAntiTriggers(description)).toBe(
      "NOT FOR deploy verification or real-Chrome UI confirmation (use Interceptor), simple single-URL fetches (use WebFetch)",
    );
  });

  test("extracts a SKIP: clause up to the sentence boundary", () => {
    const description =
      "Apify-based scraping for social media and e-commerce. USE WHEN scraping Instagram, LinkedIn. " +
      "SKIP: X/Twitter bookmarks (use X-API skill) and progressive scraping (use BrightData).";
    expect(extractAntiTriggers(description)).toBe(
      "SKIP: X/Twitter bookmarks (use X-API skill) and progressive scraping (use BrightData)",
    );
  });

  test("falls back to a bare NOT clause when NOT FOR / SKIP: are absent", () => {
    const description =
      "Router for spec-driven development. Loads the specflow skill when the project has a .specify/ directory. " +
      "Do NOT trigger on bare \"spec\" without a path or an explicit command.";
    expect(extractAntiTriggers(description)).toBe(
      "NOT trigger on bare \"spec\" without a path or an explicit command",
    );
  });

  test("prefers NOT FOR over a coincidental bare NOT earlier in the same clause", () => {
    const description = "Some skill. NOT FOR ad-hoc swarms or TeamCreate (use Delegation).";
    expect(extractAntiTriggers(description)).toBe("NOT FOR ad-hoc swarms or TeamCreate (use Delegation)");
  });

  test("returns undefined when no anti-trigger marker is present", () => {
    expect(extractAntiTriggers("Static visual content via Flux, Nano Banana Pro, GPT-Image-1.")).toBeUndefined();
  });

  test("is case-sensitive — lowercase 'not' in ordinary prose is not a marker", () => {
    const description = "This does not require network access and cannot be disabled.";
    expect(extractAntiTriggers(description)).toBeUndefined();
  });

  test("returns undefined for an empty description", () => {
    expect(extractAntiTriggers("")).toBeUndefined();
  });
});

describe("extractUseWhenTriggers", () => {
  test("splits a comma-separated USE WHEN clause into trigger phrases", () => {
    const description = "Multi-lens PR review. USE WHEN review PR, code review, security review, audit PR.";
    expect(extractUseWhenTriggers(description)).toEqual([
      "review PR",
      "code review",
      "security review",
      "audit PR",
    ]);
  });

  test("stops at a NOT FOR / SKIP: tail so anti-triggers do not leak into triggers", () => {
    const description = "Scraping. USE WHEN scrape URL, crawl site. NOT FOR simple public content (use WebFetch).";
    expect(extractUseWhenTriggers(description)).toEqual(["scrape URL", "crawl site"]);
  });

  test("stops at a bare NOT anti-trigger — it never leaks into or duplicates the triggers", () => {
    // "USE WHEN <list>. Do NOT trigger on X" must not sweep the anti-trigger
    // clause into triggers (it belongs on the `not:` line, via extractAntiTriggers).
    const description = "Router. USE WHEN spec-driven, specflow. Do NOT trigger on bare spec.";
    const triggers = extractUseWhenTriggers(description);
    expect(triggers).toContain("spec-driven");
    expect(triggers.some((t) => /\bNOT\b|bare spec/.test(t))).toBe(false); // anti-trigger not swept in
    // And the anti-trigger IS still surfaced separately as the `not:` clause.
    expect(extractAntiTriggers(description)).toContain("NOT trigger on bare spec");
  });

  test("returns [] when there is no USE WHEN clause", () => {
    expect(extractUseWhenTriggers("Static visual content via Flux.")).toEqual([]);
  });

  test("returns [] for an empty description", () => {
    expect(extractUseWhenTriggers("")).toEqual([]);
  });
});

describe("leadClause", () => {
  test("strips an inline USE WHEN tail", () => {
    const description = "Multi-agent coordination via shared blackboard. USE WHEN register a project, create work items.";
    expect(leadClause(description)).toBe("Multi-agent coordination via shared blackboard.");
  });

  test("strips an inline NOT FOR tail", () => {
    const description = "Adversarial analysis via 32 parallel expert agents. NOT FOR pure attack on systems.";
    expect(leadClause(description)).toBe("Adversarial analysis via 32 parallel expert agents.");
  });

  test("strips an inline SKIP: tail", () => {
    const description = "4-tier progressive scraping. SKIP: single-URL fetches.";
    expect(leadClause(description)).toBe("4-tier progressive scraping.");
  });

  test("does not strip a bare NOT (only USE WHEN / NOT FOR / SKIP: truncate the lead clause)", () => {
    const description = "Router for spec-driven development. Do NOT trigger on bare \"spec\".";
    expect(leadClause(description)).toBe(description);
  });

  test("returns the whole description when no marker is present", () => {
    expect(leadClause("Plain description with no markers.")).toBe("Plain description with no markers.");
  });

  test("handles an empty description", () => {
    expect(leadClause("")).toBe("");
  });
});

describe("truncateAtWordBoundary", () => {
  test("leaves short text untouched", () => {
    expect(truncateAtWordBoundary("short text", 160)).toBe("short text");
  });

  test("cuts long text on a word boundary and appends an ellipsis", () => {
    const long = "word ".repeat(60).trim(); // 299 chars
    const result = truncateAtWordBoundary(long, 160);
    expect(result.length).toBeLessThanOrEqual(160); // ellipsis reserved: total never exceeds maxLength
    expect(result.endsWith("…")).toBe(true);
    expect(result.endsWith(" …")).toBe(false); // no trailing space before the ellipsis
  });

  test("never splits mid-word", () => {
    const long = "supercalifragilisticexpialidocious ".repeat(10).trim();
    const result = truncateAtWordBoundary(long, 20);
    const withoutEllipsis = result.replace(/…$/, "").trim();
    expect(long.startsWith(withoutEllipsis)).toBe(true);
  });
});

describe("renderSkillRegistryEntry", () => {
  function skill(overrides: Partial<SomaSkill> = {}): SomaSkill {
    return {
      name: "Browser",
      path: "/Users/jc/.soma/skills/browser",
      description: "Headless browser automation via agent-browser.",
      triggers: [],
      ...overrides,
    };
  }

  test("renders name, lead description, and path on one line", () => {
    const entry = renderSkillRegistryEntry(skill());
    expect(entry).toBe("- **Browser** — Headless browser automation via agent-browser. → /Users/jc/.soma/skills/browser");
  });

  test("omits the triggers line when triggers is empty", () => {
    const entry = renderSkillRegistryEntry(skill());
    expect(entry).not.toContain("triggers:");
  });

  test("includes a triggers line, comma-joined, when triggers is non-empty", () => {
    const entry = renderSkillRegistryEntry(skill({ triggers: ["algorithm", "ideal state", "VSA"] }));
    expect(entry).toContain("triggers: algorithm, ideal state, VSA");
  });

  test("falls back to USE WHEN prose for the triggers line when the array is empty (audit §6)", () => {
    // The routing signal must not be silently deleted: this skill has no
    // structured triggers but declares USE WHEN prose, so the compactor recovers
    // the trigger phrases rather than stripping USE WHEN and rendering nothing.
    const entry = renderSkillRegistryEntry(
      skill({
        triggers: [],
        description: "Disciplined diagnosis loop for hard bugs. USE WHEN diagnose, debug, root cause, regression.",
      }),
    );
    expect(entry).toContain("triggers: diagnose, debug, root cause, regression");
    // and the summary still drops the USE WHEN tail (kept tight, signal on its own line)
    expect(entry.split("\n")[0]).not.toContain("USE WHEN");
  });

  test("structured triggers win over USE WHEN prose when both are present", () => {
    const entry = renderSkillRegistryEntry(
      skill({
        triggers: ["curated-a", "curated-b"],
        description: "Some skill. USE WHEN prose-x, prose-y.",
      }),
    );
    expect(entry).toContain("triggers: curated-a, curated-b");
    expect(entry).not.toContain("prose-x");
  });

  test("omits the not: line when the description carries no anti-trigger clause", () => {
    const entry = renderSkillRegistryEntry(skill());
    expect(entry).not.toContain("not:");
  });

  test("includes a not: line when the description carries a NOT FOR / SKIP: clause", () => {
    const entry = renderSkillRegistryEntry(
      skill({ description: "Headless browser automation. NOT FOR deploy verification (use Interceptor)." }),
    );
    expect(entry).toContain("not: NOT FOR deploy verification (use Interceptor)");
  });

  test("renders both triggers and not: lines when both are present", () => {
    const entry = renderSkillRegistryEntry(
      skill({
        triggers: ["scrape", "crawl"],
        description: "4-tier progressive scraping. NOT FOR simple public content (use WebFetch directly).",
      }),
    );
    const lines = entry.split("\n");
    expect(lines[0]).toContain("- **Browser**");
    expect(lines).toContainEqual(expect.stringContaining("triggers: scrape, crawl"));
    expect(lines).toContainEqual(expect.stringContaining("not: NOT FOR simple public content (use WebFetch directly)"));
  });

  test("degrades gracefully when the description is empty", () => {
    const entry = renderSkillRegistryEntry(skill({ description: "" }));
    expect(entry).toBe("- **Browser** → /Users/jc/.soma/skills/browser");
  });
});

describe("renderSkills — compact registry projection", () => {
  test("keeps the heading and still lists a single portable skill", () => {
    const rendered = renderSkills(portableProjectionInput);
    expect(rendered.startsWith("# Soma Skills\n\n")).toBe(true);
    expect(rendered).toContain("- **Ledger Update**");
    expect(rendered).toContain("triggers: ledger, status update");
  });

  test("reports 'no Soma skills' when the skill list is empty", () => {
    const rendered = renderSkills({
      ...portableProjectionInput,
      profile: { ...portableProjectionInput.profile, skills: [] },
    });
    expect(rendered).toContain("No Soma skills were declared.");
  });

  test("no longer inlines full skill bodies — the projection is the compact registry only", () => {
    // The old verbose format emitted a `## <name>` heading followed by a
    // dedicated `Path:` line and a `Triggers:` bullet list. The compact
    // format folds all three into one tight entry.
    const rendered = renderSkills(portableProjectionInput);
    expect(rendered).not.toContain("## Ledger Update");
    expect(rendered).not.toContain("Path: skills/ledger-update");
  });
});

/**
 * A SYNTHETIC ~104-skill fixture — chosen to match the real catalog's
 * approximate SIZE, with a deliberate (modulo-driven, not sampled) mix: most
 * skills declare no structured `triggers` (guidance in inline `USE WHEN`
 * prose), a minority declare a real `triggers` array, and roughly a fifth
 * carry a `NOT FOR` / `SKIP:` anti-trigger clause. It exercises the budget at
 * catalog scale; it is not drawn from the shipped catalog's actual contents.
 */
function buildRepresentativeSkillFixture(count: number): SomaSkill[] {
  const skills: SomaSkill[] = [];
  for (let i = 0; i < count; i++) {
    const hasTriggers = i % 5 === 0; // ~20% carry a structured triggers array
    const hasAntiTrigger = i % 5 === 1; // ~20%
    const base =
      `A moderately long description of what skill number ${i} does, written in the same discursive ` +
      `style real skill authors use, covering the domain, the workflows it exposes, and why it exists in the first place.`;
    // Every skill carries USE WHEN prose — matching the real catalog, where 71
    // source skills declare routing guidance this way and only a minority also
    // populate the structured `triggers` array. This exercises the USE-WHEN
    // fallback (proxy-drift audit §6) at catalog scale.
    const trigger = ` USE WHEN keyword-${i}, another-keyword-${i}, or a third phrase entirely.`;
    const anti = hasAntiTrigger ? ` NOT FOR unrelated-case-${i} (use OtherSkill${i} instead).` : "";
    skills.push({
      name: `Skill${i}`,
      path: `/Users/jc/.soma/skills/skill-${i}`,
      description: `${base}${trigger}${anti}`,
      triggers: hasTriggers ? [`keyword-${i}`, `another-keyword-${i}`, "a third phrase entirely"] : [],
    });
  }
  return skills;
}

describe("renderSkills — line budget (soma#371)", () => {
  test("a ~104-skill representative catalog renders within the declared line budget", () => {
    const skills = buildRepresentativeSkillFixture(104);
    const rendered = renderSkills({
      ...portableProjectionInput,
      profile: { ...portableProjectionInput.profile, skills },
    });
    const lineCount = rendered.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(SKILL_REGISTRY_LINE_BUDGET);
  });

  test("every skill with triggers has a triggers: line — a missed trigger is diagnosable from the registry alone", () => {
    const skills = buildRepresentativeSkillFixture(104);
    const rendered = renderSkills({
      ...portableProjectionInput,
      profile: { ...portableProjectionInput.profile, skills },
    });
    for (const skill of skills) {
      if (skill.triggers.length === 0) continue;
      const entry = renderSkillRegistryEntry(skill);
      expect(rendered).toContain(entry);
      expect(entry).toContain(`triggers: ${skill.triggers.join(", ")}`);
    }
  });

  test("no entry with USE WHEN prose loses its routing signal (audit §6 regression guard)", () => {
    const skills = buildRepresentativeSkillFixture(104);
    const rendered = renderSkills({
      ...portableProjectionInput,
      profile: { ...portableProjectionInput.profile, skills },
    });
    // Every fixture skill carries USE WHEN prose, so every projected entry must
    // carry a triggers: line — whether sourced from the structured array or
    // recovered from the prose. Zero entries with neither routing form.
    for (const skill of skills) {
      const entry = renderSkillRegistryEntry(skill);
      expect(rendered).toContain(entry);
      expect(entry).toContain("triggers:");
    }
  });

  test("a 30-skill catalog (the issue's minimum representative size) also fits the budget", () => {
    const skills = buildRepresentativeSkillFixture(30);
    const rendered = renderSkills({
      ...portableProjectionInput,
      profile: { ...portableProjectionInput.profile, skills },
    });
    expect(rendered.split("\n").length).toBeLessThanOrEqual(SKILL_REGISTRY_LINE_BUDGET);
  });
});
