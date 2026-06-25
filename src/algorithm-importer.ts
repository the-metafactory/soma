import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defaultSomaRepoPath } from "./repo-path";
import type { AlgorithmImportOptions, AlgorithmImportPlan, AlgorithmImportResult, ImportSourceCheck } from "./types";

const FALLBACK_ALGORITHM_SOURCE = "v6.3.0.md";

// soma#354: the-algorithm SKILL.md + RunAlgorithm.md ship as plain `.md` in the
// repo (no longer code-generated). Read them from the bundled source on import,
// the same way the VSA skill is sourced from `src/skills/VSA`.
const BUNDLED_SKILL_SUBPATH = "src/skills/the-algorithm";

function readBundledSkillFile(rel: string): Promise<string> {
  return readFile(join(defaultSomaRepoPath(), BUNDLED_SKILL_SUBPATH, rel), "utf8");
}

const OPTIONAL_SOURCE_FILES = [
  { path: "capabilities.md", target: "references/capabilities.md", required: false },
  { path: "mode-detection.md", target: "references/mode-detection.md", required: false },
  { path: "parameter-schema.md", target: "references/parameter-schema.md", required: false },
  { path: "ideate-loop.md", target: "references/ideate-loop.md", required: false },
  { path: "optimize-loop.md", target: "references/optimize-loop.md", required: false },
] as const;

interface AlgorithmSource {
  path: string;
  target: string;
  required: boolean;
}

interface AlgorithmImportSources {
  sources: AlgorithmSource[];
  sourceChecks: ImportSourceCheck[];
}

function resolveHomes(options: AlgorithmImportOptions = {}): { paiAlgorithmDir: string; somaHome: string } {
  const home = resolve(options.homeDir ?? homedir());

  return {
    paiAlgorithmDir: resolve(options.paiAlgorithmDir ?? join(home, ".claude/PAI/Algorithm")),
    somaHome: resolve(options.somaHome ?? join(home, ".soma")),
  };
}

function normalizeLatestAlgorithmPointer(pointer: string): string {
  const trimmed = pointer.trim();
  return trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
}

function activeAlgorithmSourcePath(paiAlgorithmDir: string): string {
  const latestPath = join(paiAlgorithmDir, "LATEST");

  if (existsSync(latestPath)) {
    return normalizeLatestAlgorithmPointer(readFileSync(latestPath, "utf8"));
  }

  return FALLBACK_ALGORITHM_SOURCE;
}

function discoverAlgorithmSources(paiAlgorithmDir: string): AlgorithmSource[] {
  return [
    { path: activeAlgorithmSourcePath(paiAlgorithmDir), target: "references/algorithm.md", required: true },
    ...OPTIONAL_SOURCE_FILES,
  ];
}

function sourceCheck(paiAlgorithmDir: string, source: AlgorithmSource): ImportSourceCheck {
  const path = join(paiAlgorithmDir, source.path);

  return {
    path,
    required: source.required,
    present: existsSync(path),
  };
}

function inspectAlgorithmSources(paiAlgorithmDir: string): AlgorithmImportSources {
  const sources = discoverAlgorithmSources(paiAlgorithmDir);

  return {
    sources,
    sourceChecks: sources.map((source) => sourceCheck(paiAlgorithmDir, source)),
  };
}

export function planAlgorithmImport(options: AlgorithmImportOptions = {}): AlgorithmImportPlan {
  const homes = resolveHomes(options);
  const { sources, sourceChecks } = inspectAlgorithmSources(homes.paiAlgorithmDir);
  const targetFiles = [
    "skills/the-algorithm/SKILL.md",
    "skills/the-algorithm/Workflows/RunAlgorithm.md",
    ...sources.filter((source, index) => source.required || sourceChecks[index]?.present).map((source) => `skills/the-algorithm/${source.target}`),
  ];

  return {
    apply: false,
    paiAlgorithmDir: homes.paiAlgorithmDir,
    somaHome: homes.somaHome,
    sourceFiles: sourceChecks.map((check) => check.path),
    sourceChecks,
    targetFiles: targetFiles.map((path) => join(homes.somaHome, path)),
  };
}

export async function importAlgorithm(options: AlgorithmImportOptions = {}): Promise<AlgorithmImportResult> {
  const homes = resolveHomes(options);
  const { sources: algorithmSources, sourceChecks } = inspectAlgorithmSources(homes.paiAlgorithmDir);
  const sources = new Map<string, string>();

  for (const check of sourceChecks) {
    if (check.required && !check.present) {
      throw new Error(`Required Algorithm source file is missing: ${check.path}`);
    }
  }

  for (const source of algorithmSources) {
    const path = join(homes.paiAlgorithmDir, source.path);
    const content = await readFile(path, "utf8").catch((error: unknown) => {
      if (!source.required) {
        return undefined;
      }

      throw error;
    });

    if (content !== undefined) {
      sources.set(source.target, content);
    }
  }
  const files = new Map<string, string>();

  files.set("skills/the-algorithm/SKILL.md", await readBundledSkillFile("SKILL.md"));
  files.set("skills/the-algorithm/Workflows/RunAlgorithm.md", await readBundledSkillFile("Workflows/RunAlgorithm.md"));

  for (const [path, content] of sources) {
    files.set(`skills/the-algorithm/${path}`, content);
  }

  const written: string[] = [];

  for (const [relativePath, content] of files) {
    const target = join(homes.somaHome, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${content.trimEnd()}\n`, "utf8");
    written.push(target);
  }

  return {
    paiAlgorithmDir: homes.paiAlgorithmDir,
    somaHome: homes.somaHome,
    files: written,
  };
}
