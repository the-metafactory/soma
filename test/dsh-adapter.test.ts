import { mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { dshAdapter, installSomaForDsh, planSomaForDshInstall, projectDsh, projectDshHome } from "../src/index";
import { dshMemoryIndexFile } from "../src/adapters/dsh/adapter";
import { DSH_AGENTS_BLOCK_BEGIN, DSH_AGENTS_BLOCK_END, DSH_HOME_FILES, dshInstallSpec, removeDshAgentsBlock } from "../src/adapters/dsh";
import type { ProjectionInput } from "../src/index";
import { portableProjectionInput } from "./fixtures";
import { expectPlanCoversApplyModuloBundledSkills } from "./fixtures";

const DSH_MEMORY_INDEX = "skills/soma/memory-index.md";

function withIndex(indexContent?: string): ProjectionInput {
  return indexContent === undefined
    ? portableProjectionInput
    : { ...portableProjectionInput, memory: { indexContent } };
}

test("dsh adapter builds a portable context bundle", () => {
  const bundle = projectDsh(portableProjectionInput);

  expect(bundle.substrate).toBe("dsh");
  expect(bundle.instructions).toContain("DeepSeek Harness");
  expect(bundle.instructions).toContain("Keep personal assistant context portable across substrates.");
  expect(bundle.instructions).toContain("ISC-PORTABLE-1");
  expect(bundle.files.map((file) => file.path)).toEqual([
    ".dsh/soma/context.md",
    ".dsh/soma/memory-layout.md",
    ".dsh/soma/skills.md",
    ".dsh/soma/policy.md",
    ".dsh/soma/communication.md",
  ]);
});

test("dsh home projects the entry skill + colocated refs — and NO catalog or portable copies (loader mode)", () => {
  const bundle = projectDshHome(portableProjectionInput, "/tmp/soma-home");

  expect(bundle.substrate).toBe("dsh");
  // The fixture carries an active VSA, so the active-vsa file is present.
  expect(bundle.files.map((file) => file.path)).toEqual([
    "skills/soma/SKILL.md",
    "skills/soma/memory-layout.md",
    "skills/soma/policy.md",
    "skills/soma/lifecycle.md",
    "skills/soma/communication.md",
    "skills/soma/active-vsa.md",
  ]);
  const paths = bundle.files.map((file) => file.path);
  // Loader substrate (soma#638): DSH's own loader advertises skills, so the
  // bundle emits NO skill catalog…
  expect(paths).not.toContain("skills/soma/skills.md");
  // …NO portable-skill copies (install symlinks the registry instead)…
  expect(paths.some((path) => path.startsWith("skills/Ledger Update/"))).toBe(false);
  // …and NO static the-algorithm override (the symlink occupies that slot; a
  // real file here would collide with it).
  expect(paths).not.toContain("skills/the-algorithm/SKILL.md");
});

test("dsh entry skill carries DSH frontmatter (incl. whenToUse) and the communication read-instruction", () => {
  const bundle = projectDshHome(portableProjectionInput, "/tmp/soma-home");
  const skill = bundle.files.find((file) => file.path === "skills/soma/SKILL.md")?.content ?? "";

  expect(skill.startsWith("---\n")).toBe(true);
  expect(skill).toContain("name: soma");
  expect(skill).toContain("description: Use when work depends on portable personal assistant context");
  // DSH's loader parses a whenToUse hint no other substrate's renderer emits.
  expect(skill).toContain("whenToUse:");
  expect(skill).toContain("short-description: Portable personal assistant context");
  // The contract must be TOLD to be read, not just handed over
  // (test/communication-contract.test.ts enforces this across surfaces).
  expect(skill.toLowerCase()).toContain("communication");
  expect(skill).toContain("soma memory recall");
});

test("dsh home OMITS the memory INDEX file when no index exists yet, projects it verbatim when present", () => {
  const absent = projectDshHome(portableProjectionInput, "/tmp/soma-home");
  expect(absent.files.map((file) => file.path)).not.toContain(DSH_MEMORY_INDEX);

  const indexContent = "# Soma Memory Index\n\n## Procedural\n- restart-gateway — how · principal, verified 2d ago\n";
  const present = projectDshHome(withIndex(indexContent), "/tmp/soma-home");
  const indexFile = present.files.find((file) => file.path === DSH_MEMORY_INDEX);
  expect(indexFile?.content).toBe(indexContent);

  for (const empty of [withIndex(""), withIndex("   \n")]) {
    expect(dshMemoryIndexFile(empty)).toHaveLength(0);
  }
});

test("dsh policy projection carries the behavior advisory + self-healing doctrine", () => {
  const bundle = projectDshHome(portableProjectionInput, "/tmp/soma-home");
  const policy = bundle.files.find((file) => file.path === "skills/soma/policy.md")?.content ?? "";
  expect(policy).toContain("Policy Projection");
  expect(policy).toContain("Substrate: dsh");
});

test("dsh detect() reports true when DSH_HOME is set", async () => {
  const original = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = "/tmp/any-dsh-home";
    expect(await dshAdapter.detect()).toBe(true);
  } finally {
    if (original === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = original;
  }
});

test("dsh install spec declares the full home file set with a reserved uninstall", () => {
  expect(dshInstallSpec.substrate).toBe("dsh");
  expect(dshInstallSpec.defaultHome).toBe(".dsh");
  expect(dshInstallSpec.skillsDiscovery).toBe("loader");
  expect(dshInstallSpec.skillsLoading).toBe("on-demand");
  expect([...dshInstallSpec.ownedSubtrees ?? []]).toEqual(["skills/soma"]);
  expect(DSH_HOME_FILES).toContain("AGENTS.md");
  expect(DSH_HOME_FILES).toContain("skills/soma/startup-context.md");
  expect(DSH_HOME_FILES).toContain("skills/soma/soma-repo.txt");
  expect(dshInstallSpec.uninstall.kind).toBe("reserved");
});

test("dsh install dry-run lists every substrate file apply reports (modulo bundled skills)", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-dsh-install-"));
  try {
    const plan = planSomaForDshInstall({ homeDir });
    const result = await installSomaForDsh({ homeDir });

    expect(plan.substrateHome).toBe(join(homeDir, ".dsh"));
    expect(plan.substrateFiles).toEqual(DSH_HOME_FILES.map((path) => join(homeDir, ".dsh", path)));
    await expectPlanCoversApplyModuloBundledSkills(plan.substrateFiles, result.substrateHome.files);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("dsh install links the registry into the loader and patches AGENTS.md marker-guarded", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-dsh-loader-"));
  try {
    const result = await installSomaForDsh({ homeDir });
    const dshHome = join(homeDir, ".dsh");

    // Loader substrate: the curated registry lands as SYMLINKS into
    // ~/.soma/skills (the bundled skills are the greenfield registry).
    expect(result.projectedSkills.length).toBeGreaterThan(0);
    const algorithmLink = join(dshHome, "skills", "the-algorithm");
    const target = resolve(await readlink(algorithmLink));
    expect(target.startsWith(resolve(homeDir, ".soma", "skills"))).toBe(true);

    // …while the soma entry skill stays a REAL Soma-owned file.
    const entryStat = await readFile(join(dshHome, "skills/soma/SKILL.md"), "utf8");
    expect(entryStat).toContain("name: soma");

    // VSA reaches its dedicated managed projection.
    await expect(readFile(join(dshHome, "skills/VSA/SKILL.md"), "utf8")).resolves.toContain("name:");

    // AGENTS.md is patched, not overwritten: markers present, pointer inside.
    const agents = await readFile(join(dshHome, "AGENTS.md"), "utf8");
    expect(agents).toContain(DSH_AGENTS_BLOCK_BEGIN);
    expect(agents).toContain(DSH_AGENTS_BLOCK_END);
    expect(agents).toContain("skills/soma/SKILL.md");

    // Re-install is byte-stable on the user-owned file.
    const before = await readFile(join(dshHome, "AGENTS.md"), "utf8");
    await installSomaForDsh({ homeDir });
    const after = await readFile(join(dshHome, "AGENTS.md"), "utf8");
    expect(after).toBe(before);

    // Unpatch on a Soma-only file (install created it) removes it outright —
    // the documented removeDshAgentsBlock contract.
    expect(await removeDshAgentsBlock(dshHome)).toBe(join(dshHome, "AGENTS.md"));
    expect(await readFile(join(dshHome, "AGENTS.md"), "utf8").catch(() => "REMOVED")).toBe("REMOVED");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
