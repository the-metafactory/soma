import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { installBundledSkillsIntoHome, listBundledSkills } from "../src/bundled-skills";
import { loadSomaHomeAlgorithmCapabilityRegistry } from "../src/algorithm-capabilities";

const SKILLS_ROOT = resolve(import.meta.dir, "..", "src", "skills");

/**
 * Matches an in-repo skill-relative pointer the way a bundled skill writes one:
 * a backticked path under `references/`, `Workflows/`, or `Examples/` ending in
 * `.md`. Deliberately narrow — prose that merely mentions a directory ("the
 * references above") must not read as a pointer, or the guard becomes noise
 * nobody trusts.
 */
const POINTER = /`((?:references|Workflows|Examples)\/[A-Za-z0-9._-]+\.md)`/g;

/**
 * Pointers to files the bundle deliberately does NOT ship. `capabilities.local.md`
 * is the adopter's own capability table (soma#574): install must never create or
 * overwrite it, so shipping one would defeat its purpose. The docs still have to
 * name it, or nobody learns it exists.
 */
const UNSHIPPED_BY_DESIGN = new Set(["references/capabilities.local.md"]);

async function walkMarkdown(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await walkMarkdown(child)));
    else if (entry.name.endsWith(".md")) out.push(child);
  }
  return out;
}

async function exists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

describe("bundled skill references", () => {
  test("every skill-relative pointer in a bundled skill resolves inside the bundle", async () => {
    const dangling: string[] = [];

    for (const skill of await listBundledSkills()) {
      const skillRoot = join(SKILLS_ROOT, skill);
      for (const file of await walkMarkdown(skillRoot)) {
        for (const match of (await readFile(file, "utf8")).matchAll(POINTER)) {
          const pointer = match[1];
          if (UNSHIPPED_BY_DESIGN.has(pointer)) continue;
          if (!(await exists(join(skillRoot, pointer)))) {
            dangling.push(`${skill}/${relative(skillRoot, file)}  ->  ${pointer}`);
          }
        }
      }
    }

    // A bundled skill that tells the agent to read a file the bundle does not
    // ship is a defect the AUTHOR's machine hides: install leaves
    // principal-added files under a skill dir untouched, so a pointer that
    // resolves against a rich local home dangles on every fresh install. Same
    // blindness for a renamed target — the old name keeps resolving locally
    // long after the file moved.
    expect(dangling).toEqual([]);
  });

  test("the-algorithm's capability table parses with no unsupported rows", async () => {
    // `references/capabilities.md` is runtime input, not prose:
    // loadSomaHomeAlgorithmCapabilityRegistry reads it out of the soma home and
    // turns its rows into capability definitions, degrading SILENTLY to an
    // empty table when the file is missing or a row is malformed. Point the
    // loader at the repo bundle (shaped as a soma home) so the shipped table is
    // parsed here rather than only on someone's laptop.
    const registry = await loadSomaHomeAlgorithmCapabilityRegistry({
      somaHome: resolve(import.meta.dir, "..", "src"),
    });

    // A parse that yields nothing means the table stopped being a table —
    // a mis-edited header cell silently empties the registry.
    expect(registry.definitions.length).toBeGreaterThan(0);

    // `unsupported` is how a row reports that it could not become a capability:
    // a `Skill("…")` target nothing answers to, or an invoke cell in none of the
    // recognised shapes. Most shipped rows target principal-authored skills and
    // legitimately land here on a machine that lacks them — that is a policy
    // question, not a defect. What is a defect is a row aimed at a skill Soma
    // itself ships under a DIFFERENT name than the row uses: the #329 ISA→VSA
    // rename left `Skill("ISA")` in the mandatory scaffolding row, dead
    // everywhere. Bundled targets must resolve.
    const bundled = await listBundledSkills();
    const staleBundledTargets = registry.unsupported.filter((name) =>
      bundled.some((skill) => name.toLowerCase().includes(skill.toLowerCase())),
    );
    expect(staleBundledTargets).toEqual([]);
  });

  test("install overwrites a bundled skill file but preserves a principal-added sibling", async () => {
    // The load-bearing guarantee behind capabilities.local.md (soma#574): the
    // adopter's capability rows survive an install ONLY because this copy never
    // deletes. It was asserted in a JSDoc comment and covered by nothing, so a
    // later home-skills reconcile — the natural symmetry with
    // reconcileOwnedSubtrees, which already exists for substrates — would wipe
    // every adopter's table with no error and no obvious cause.
    const homeDir = await mkdtemp(join(tmpdir(), "soma-bundled-preserve-"));
    try {
      const references = join(homeDir, ".soma", "skills", "the-algorithm", "references");
      await mkdir(references, { recursive: true });
      // A bundled file, locally edited: install must restore it.
      await writeFile(join(references, "capabilities.md"), "LOCALLY EDITED BUNDLED FILE\n", "utf8");
      // A principal-added sibling install does not ship: it must survive untouched.
      await writeFile(join(references, "capabilities.local.md"), "PRINCIPAL ROWS\n", "utf8");

      await installBundledSkillsIntoHome({ homeDir });

      expect(await readFile(join(references, "capabilities.local.md"), "utf8")).toBe("PRINCIPAL ROWS\n");
      expect(await readFile(join(references, "capabilities.md"), "utf8")).not.toBe("LOCALLY EDITED BUNDLED FILE\n");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  test("install backs up a customised capability table without changing precedence", async () => {
    // soma#574: the capability table is the one bundled file adopters were
    // expected to edit, and this install now overwrites it every run. Their rows
    // must not vanish — but the backup must NOT become the overlay (Sage
    // review): the overlay wins, so promoting an older bundled table there would
    // reinstate the PAI-era rows this change replaces, silently undoing the
    // upgrade for every existing install.
    const homeDir = await mkdtemp(join(tmpdir(), "soma-capability-migrate-"));
    try {
      const references = join(homeDir, ".soma", "skills", "the-algorithm", "references");
      await mkdir(references, { recursive: true });
      await writeFile(join(references, "capabilities.md"), "| Capability |\n|---|\n| MyOwnRow |\n", "utf8");

      await installBundledSkillsIntoHome({ homeDir });

      // Kept, in a content-addressed file nothing reads.
      const backups = async () => (await readdir(references)).filter((f) => f.startsWith("capabilities.pre-upgrade."));
      const first = await backups();
      expect(first).toHaveLength(1);
      expect(await readFile(join(references, first[0]), "utf8")).toContain("MyOwnRow");
      // NOT promoted to the overlay — that would win over the shipped table.
      await expect(readFile(join(references, "capabilities.local.md"), "utf8")).rejects.toThrow();
      // And the bundled copy was replaced with the shipped one.
      expect(await readFile(join(references, "capabilities.md"), "utf8")).toContain("Algorithm Capabilities Reference");

      // A second install with nothing new saves nothing: same content, same
      // content-addressed name, already there.
      await installBundledSkillsIntoHome({ homeDir });
      expect(await backups()).toEqual(first);

      // But an adopter who kept editing capabilities.md — not yet having learned
      // that rows moved — must not lose those edits on the NEXT upgrade. Skipping
      // whenever any backup existed silently overwrote them (Sage review).
      await writeFile(join(references, "capabilities.md"), "| Capability |\n|---|\n| SecondRoundRow |\n", "utf8");
      await installBundledSkillsIntoHome({ homeDir });
      const second = await backups();
      expect(second).toHaveLength(2);
      const contents = await Promise.all(second.map((f) => readFile(join(references, f), "utf8")));
      // Both rounds kept; neither overwrote the other.
      expect(contents.some((c) => c.includes("MyOwnRow"))).toBe(true);
      expect(contents.some((c) => c.includes("SecondRoundRow"))).toBe(true);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  test("no bundled skill instructs the agent toward a PAI-only path or an unsubstituted placeholder", async () => {
    // These accumulate silently because they keep WORKING on the machine that
    // authored them: `~/.claude/PAI/TOOLS/…` resolves there, and a `{{DA_NAME}}`
    // reads as a name to whoever already knows what it stands for. On a fresh
    // install the path is absent and the placeholder ships as literal text.
    // Nothing substitutes these at projection time — rewriteSubstrateProjectionContent
    // returns claude-code's copy verbatim and does no templating for anyone else.
    // soma#574.
    const FORBIDDEN: { pattern: RegExp; why: string }[] = [
      { pattern: /~\/\.claude\//g, why: "Claude-home path in a portable skill" },
      { pattern: /\bPAI\/(?:TOOLS|MEMORY|ALGORITHM|DOCUMENTATION)\b/g, why: "PAI tree path" },
      // Bare `PAI`, and the PAI tool path written RELATIVE. The narrow patterns
      // above reported the bundle clean while three shipped references still
      // carried a "### PAI-Specific Guidance" section and told the agent to
      // "send to LLM via PAI Inference Tool (`bun TOOLS/Inference.ts`)" — a
      // guard that matches the spellings you already removed and misses the
      // ones you did not is worse than none, because it is believed.
      { pattern: /\bPAI\b/g, why: "PAI named in a portable skill" },
      { pattern: /\bTOOLS\/[A-Za-z0-9._-]+/g, why: "PAI tool path (relative)" },
      // Identity placeholders only. `{{SHA}}` / `{{VERSION}}` and friends are
      // sample values inside example documents — a generic `{{[A-Z_]+}}` would
      // flag those and train everyone to ignore this test.
      { pattern: /\{\{(?:DA_NAME|PRINCIPAL_NAME|ASSISTANT_NAME|HARNESS_USER_DIR)\}\}/g, why: "unsubstituted identity placeholder" },
      // The specific personas the bundle used to mandate. A shipped skill must
      // not name a particular external model as doctrine — that is what the
      // Contract() rows exist to express portably. Named here rather than
      // pattern-matched generically, because "a model name" has no shape; these
      // three are the ones that were in the bundle and whose return is the
      // regression worth catching (Sage review — the PR previously claimed this
      // guard covered named models when it did not).
      { pattern: /\b(?:Forge|Anvil|Cato)\b/g, why: "named external model in a portable skill" },
    ];

    // `migrate-pai-purpose` exists to migrate a principal OFF PAI, so naming a
    // Claude-home path is its subject matter rather than residue. Scoped to that
    // ONE pattern (Sage review): skipping the whole skill also skipped the PAI-
    // tree and placeholder checks, so the test could not support the universal
    // claim its name makes.
    const EXEMPT: Record<string, string[]> = {
      "migrate-pai-purpose": ["Claude-home path in a portable skill", "PAI named in a portable skill"],
    };

    const found: string[] = [];
    for (const skill of await listBundledSkills()) {
      const exempt = new Set(EXEMPT[skill] ?? []);
      const skillRoot = join(SKILLS_ROOT, skill);
      for (const file of await walkMarkdown(skillRoot)) {
        const body = await readFile(file, "utf8");
        for (const { pattern, why } of FORBIDDEN) {
          if (exempt.has(why)) continue;
          for (const match of body.matchAll(pattern)) {
            found.push(`${skill}/${relative(skillRoot, file)}: ${why} — ${match[0]}`);
          }
        }
      }
    }

    expect(found).toEqual([]);
  });
});
