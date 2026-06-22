import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { allInstallSpecs } from "./install-spec-registry";
import { SOMA_MEMORY_CATEGORIES, SOMA_MEMORY_CATEGORY_READMES } from "./memory-readmes";
import { createPaths } from "./paths";
import type { ProjectionInput, SomaHomeBootstrapOptions, SomaHomeBootstrapResult, SomaSkill } from "./types";

// #88 / DD-2: canonical PAI v5.0.0 memory taxonomy (17 substrate-neutral +
// 2 PAI-bound). The directory list and per-category README content live in
// `memory-readmes.ts` so the install planner, bootstrap, and tests all share
// one source of truth.
const MEMORY_DIRS = SOMA_MEMORY_CATEGORIES;

function resolveSomaHome(options: SomaHomeBootstrapOptions = {}): string {
  return createPaths(options).root();
}

function renderAssistantProfile(): string {
  return [
    "# Assistant",
    "",
    "Name: soma",
    "Display name: Soma",
    "",
    "## Traits",
    "",
    "- portable: true",
    "- concise: true",
  ].join("\n");
}

function renderPrincipalProfile(): string {
  return [
    "# Principal",
    "",
    "Name: principal",
    "Preferred name: Principal",
    "",
    "## Profile",
    "",
    "- status: starter-profile",
  ].join("\n");
}

function renderTelosProfile(): string {
  return [
    "# Telos",
    "",
    "Mission: Keep personal assistant context portable across substrates.",
    "",
    "## Goals",
    "",
    "- Establish Soma as the durable personal assistant home.",
    "",
    "## Principles",
    "",
    "- Substrate adapters translate; they do not own core concepts.",
    "- Filesystem-native state is the portability layer.",
    "",
    "## Commitments",
    "",
    "- Keep memory filesystem-native.",
  ].join("\n");
}

function valueAfterPrefix(content: string, prefix: string, fallback: string): string {
  const line = content.split("\n").find((candidate) => candidate.startsWith(prefix));
  const value = line?.slice(prefix.length).trim();
  return value === "" ? fallback : (value ?? fallback);
}

function sectionBullets(content: string, heading: string): string[] {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);

  if (start === -1) {
    return [];
  }

  const items: string[] = [];

  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) {
      break;
    }

    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      items.push(trimmed.slice(2).trim());
    }
  }

  return items;
}

function recordFromBullets(items: string[]): Record<string, string | boolean> {
  return Object.fromEntries(
    items.map((item) => {
      const separator = item.indexOf(":");

      if (separator === -1) {
        return [item, true];
      }

      const key = item.slice(0, separator).trim();
      const rawValue = item.slice(separator + 1).trim();
      const value = rawValue === "true" ? true : rawValue === "false" ? false : rawValue;
      return [key, value];
    }),
  );
}

function frontmatterValue(content: string, key: string, fallback: string): string {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(content);
  return match?.[1]?.trim().replace(/^["']|["']$/g, "") ?? fallback;
}

async function collectSkillFiles(root: string, current = root): Promise<{ path: string; content: string }[]> {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  const files: { path: string; content: string }[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const fullPath = join(current, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectSkillFiles(root, fullPath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const relativePath = relative(root, fullPath);

    if (relativePath.startsWith("..") || relativePath.includes(`..${sep}`)) {
      continue;
    }

    files.push({
      path: relativePath,
      content: await readFile(fullPath, "utf8"),
    });
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function loadSomaSkills(somaHome: string): Promise<SomaSkill[]> {
  const paths = createPaths(somaHome);
  const skillsRoot = paths.skills();
  const entries = await readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
  const skills: SomaSkill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillRoot = join(skillsRoot, entry.name);
    const skillContent = await readFile(join(skillRoot, "SKILL.md"), "utf8").catch(() => undefined);

    if (!skillContent) {
      continue;
    }

    skills.push({
      name: frontmatterValue(skillContent, "name", entry.name),
      path: skillRoot,
      description: frontmatterValue(skillContent, "description", ""),
      triggers: sectionBullets(skillContent, "Triggers"),
      files: await collectSkillFiles(skillRoot),
    });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadSomaProfile(somaHome: string): Promise<Omit<ProjectionInput["profile"], "skills">> {
  const paths = createPaths(somaHome);
  const assistant = await readFile(paths.resolve("profile", "assistant.md"), "utf8");
  const principal = await readFile(paths.resolve("profile", "principal.md"), "utf8");
  const telos = await readFile(paths.resolve("profile", "telos.md"), "utf8");

  return {
    assistant: {
      name: valueAfterPrefix(assistant, "Name:", "soma"),
      displayName: valueAfterPrefix(assistant, "Display name:", "Soma"),
      traits: recordFromBullets(sectionBullets(assistant, "Traits")),
    },
    principal: {
      name: valueAfterPrefix(principal, "Name:", "principal"),
      preferredName: valueAfterPrefix(principal, "Preferred name:", "Principal"),
      profile: recordFromBullets(sectionBullets(principal, "Profile")),
    },
    telos: {
      mission: valueAfterPrefix(telos, "Mission:", "Keep personal assistant context portable across substrates."),
      goals: sectionBullets(telos, "Goals"),
      principles: sectionBullets(telos, "Principles"),
      commitments: sectionBullets(telos, "Commitments"),
    },
    memory: {
      root: paths.memory(),
      work: paths.work(),
      knowledge: paths.resolve("memory", "KNOWLEDGE"),
      learning: paths.learning(),
      relationship: paths.relationship(),
      state: paths.state(),
    },
  };
}

export async function loadSomaHome(somaHome: string): Promise<ProjectionInput> {
  const profile = await loadSomaProfile(somaHome);
  const skills = await loadSomaSkills(somaHome);

  return {
    profile: {
      ...profile,
      skills,
    },
  };
}

export async function bootstrapSomaHome(options: SomaHomeBootstrapOptions = {}): Promise<SomaHomeBootstrapResult> {
  const somaHome = resolveSomaHome(options);
  const paths = createPaths(somaHome);
  const files = [
    {
      path: "profile/assistant.md",
      content: renderAssistantProfile(),
    },
    {
      path: "profile/principal.md",
      content: renderPrincipalProfile(),
    },
    {
      path: "profile/telos.md",
      content: renderTelosProfile(),
    },
    {
      path: "policy/README.md",
      content: "# Soma Policy\n\nPolicy files live here. Generated substrate projections should declare enforceable and advisory policy separately.",
    },
    {
      path: "skills/README.md",
      content: "# Soma Skills\n\nPortable Soma skills live here. Substrate-specific skills are projections.",
    },
    {
      path: "projections/README.md",
      content: "# Soma Projections\n\nGenerated substrate projections can be cached here. Substrate homes remain projections, not source of truth.",
    },
    {
      path: "isa/INDEX.md",
      content: "# Soma ISAs\n\nOne ISA per project or task lives in this directory as `<slug>.md`.\nThe active ISA slug is recorded in `memory/STATE/active.json`.\nTemplates seeded by the ISA skill live under `.templates/`.\n",
    },
  ];
  const writtenFiles: string[] = [];

  await mkdir(somaHome, { recursive: true });

  // #88 / DD-2: bootstrap the canonical PAI v5.0.0 memory taxonomy. Each
  // category directory ships a README describing what belongs there;
  // PAI-bound categories (`PAISYSTEMUPDATES`, `AUTO`) self-declare their
  // substrate provenance. README write uses `flag: "wx"` so principal edits
  // survive re-runs (idempotent contract — see test AC-3).
  for (const directory of MEMORY_DIRS) {
    await mkdir(paths.resolve("memory", directory), { recursive: true });
  }

  for (const entry of SOMA_MEMORY_CATEGORY_READMES) {
    const readmePath = paths.resolve("memory", entry.category, "README.md");
    // `flag: "wx"` makes README writes idempotent — principal edits survive
    // re-install (test AC-3). Sage R1: only record the path in `writtenFiles`
    // when the write actually happened, so callers don't see a skipped EEXIST
    // path masquerading as a fresh write.
    try {
      await writeFile(readmePath, `${entry.content}\n`, { encoding: "utf8", flag: "wx" });
      writtenFiles.push(readmePath);
    } catch (error: unknown) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
    }
  }

  // Derive from the install-spec registry so bootstrap creates a projection
  // directory for every registered substrate — the same source the install
  // planner's SOMA_BOOTSTRAP_DIRECTORIES uses, so plan and apply cannot drift.
  for (const spec of allInstallSpecs()) {
    await mkdir(join(somaHome, "projections", spec.substrate), { recursive: true });
  }

  // ISA storage layout (#32). Library CRUD (#34) owns reads/writes;
  // bootstrap only ensures the canonical directories exist. `.templates/`
  // is left empty here — Layer 2 (#33) populates skill assets; future
  // template seeding lives outside bootstrap to avoid Layer 1 → Layer 2
  // coupling.
  await mkdir(join(somaHome, "isa", ".templates"), { recursive: true });

  for (const file of files) {
    const target = join(somaHome, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${file.content}\n`, { encoding: "utf8", flag: "wx" }).catch((error: unknown) => {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
    });
    writtenFiles.push(target);
  }

  return {
    somaHome,
    context: await loadSomaHome(somaHome),
    files: writtenFiles,
  };
}
