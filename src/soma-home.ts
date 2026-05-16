import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { SomaContextInput, SomaHomeBootstrapOptions, SomaHomeBootstrapResult, SomaSkill } from "./types";

const MEMORY_DIRS = ["WORK", "KNOWLEDGE", "LEARNING", "RELATIONSHIP", "STATE"] as const;

function resolveSomaHome(options: SomaHomeBootstrapOptions = {}): string {
  return resolve(options.somaHome ?? join(resolve(options.homeDir ?? homedir()), ".soma"));
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
  const skillsRoot = join(somaHome, "skills");
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

export async function loadSomaHome(somaHome: string): Promise<SomaContextInput> {
  const assistant = await readFile(join(somaHome, "profile/assistant.md"), "utf8");
  const principal = await readFile(join(somaHome, "profile/principal.md"), "utf8");
  const telos = await readFile(join(somaHome, "profile/telos.md"), "utf8");
  const memoryRoot = join(somaHome, "memory");
  const skills = await loadSomaSkills(somaHome);

  return {
    profile: {
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
        root: memoryRoot,
        work: join(memoryRoot, "WORK"),
        knowledge: join(memoryRoot, "KNOWLEDGE"),
        learning: join(memoryRoot, "LEARNING"),
        relationship: join(memoryRoot, "RELATIONSHIP"),
        state: join(memoryRoot, "STATE"),
      },
      skills,
    },
  };
}

export async function bootstrapSomaHome(options: SomaHomeBootstrapOptions = {}): Promise<SomaHomeBootstrapResult> {
  const somaHome = resolveSomaHome(options);
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

  for (const directory of MEMORY_DIRS) {
    await mkdir(join(somaHome, "memory", directory), { recursive: true });
  }

  for (const projection of ["codex", "pi-dev", "claude-code"]) {
    await mkdir(join(somaHome, "projections", projection), { recursive: true });
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
