import { describe, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { listBundledSkills } from "../src/bundled-skills";
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
      // Identity placeholders only. `{{SHA}}` / `{{VERSION}}` and friends are
      // sample values inside example documents — a generic `{{[A-Z_]+}}` would
      // flag those and train everyone to ignore this test.
      { pattern: /\{\{(?:DA_NAME|PRINCIPAL_NAME|ASSISTANT_NAME|HARNESS_USER_DIR)\}\}/g, why: "unsubstituted identity placeholder" },
    ];

    // `migrate-pai-purpose` exists to migrate a principal OFF PAI. Naming
    // `~/.claude/…` is its subject matter, not residue.
    const EXEMPT = new Set(["migrate-pai-purpose"]);

    const found: string[] = [];
    for (const skill of await listBundledSkills()) {
      if (EXEMPT.has(skill)) continue;
      const skillRoot = join(SKILLS_ROOT, skill);
      for (const file of await walkMarkdown(skillRoot)) {
        const body = await readFile(file, "utf8");
        for (const { pattern, why } of FORBIDDEN) {
          for (const match of body.matchAll(pattern)) {
            found.push(`${skill}/${relative(skillRoot, file)}: ${why} — ${match[0]}`);
          }
        }
      }
    }

    expect(found).toEqual([]);
  });
});
