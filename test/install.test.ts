import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { installSomaForCodex, installSomaForPiDev } from "../src/index";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-install-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("installs soma source home and codex home projection", async () => {
  await withTempHome(async (homeDir) => {
    const result = await installSomaForCodex({ homeDir });

    expect(result.substrate).toBe("codex");
    expect(result.somaHome.somaHome).toBe(join(homeDir, ".soma"));
    expect(result.substrateHome.rootDir).toBe(join(homeDir, ".codex"));
    expect(result.substrateHome.files).toHaveLength(7);

    const telos = await readFile(join(homeDir, ".soma/profile/telos.md"), "utf8");
    const rules = await readFile(join(homeDir, ".codex/rules/soma.rules"), "utf8");
    const skill = await readFile(join(homeDir, ".codex/skills/soma/SKILL.md"), "utf8");

    expect(telos).toContain("Keep personal assistant context portable across substrates.");
    expect(rules).toContain(`Soma source of truth: ${join(homeDir, ".soma")}`);
    expect(skill).toContain("name: soma");
  });
});

test("install preserves existing soma profile edits before projecting to codex", async () => {
  await withTempHome(async (homeDir) => {
    const first = await installSomaForCodex({ homeDir });
    await writeFile(join(first.somaHome.somaHome, "profile/principal.md"), "# Principal\n\nName: jc\nPreferred name: JC\n", "utf8");

    const second = await installSomaForCodex({ homeDir });
    const projectedProfile = await readFile(join(homeDir, ".codex/memories/soma/profile.md"), "utf8");

    expect(second.somaHome.context.profile.principal.name).toBe("jc");
    expect(projectedProfile).toContain("Name: jc");
  });
});

test("install supports explicit soma and substrate homes", async () => {
  await withTempHome(async (homeDir) => {
    const somaHome = join(homeDir, "portable-home");
    const substrateHome = join(homeDir, "codex-home");
    const result = await installSomaForCodex({ somaHome, substrateHome });

    expect(result.somaHome.somaHome).toBe(somaHome);
    expect(result.substrateHome.rootDir).toBe(substrateHome);

    await expect(readFile(join(somaHome, "profile/assistant.md"), "utf8")).resolves.toContain("Name: soma");
    await expect(readFile(join(substrateHome, "rules/soma.rules"), "utf8")).resolves.toContain(`Soma source of truth: ${somaHome}`);
  });
});

test("installs soma source home and pi.dev home projection", async () => {
  await withTempHome(async (homeDir) => {
    const result = await installSomaForPiDev({ homeDir });

    expect(result.substrate).toBe("pi-dev");
    expect(result.somaHome.somaHome).toBe(join(homeDir, ".soma"));
    expect(result.substrateHome.rootDir).toBe(join(homeDir, ".pi"));
    expect(result.substrateHome.files).toHaveLength(8);

    const extension = await readFile(join(homeDir, ".pi/agent/extensions/soma.ts"), "utf8");
    const profile = await readFile(join(homeDir, ".pi/agent/soma/profile.md"), "utf8");

    expect(extension).toContain("soma_context");
    expect(profile).toContain("Name: soma");
  });
});
