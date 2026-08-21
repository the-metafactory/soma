import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  configureDshCordisPatch,
  DSH_CORDIS_PATCH_BEGIN,
  DSH_CORDIS_PATCH_END,
  dshHostPluginDestination,
  installDshHostPlugin,
  removeDshCordisPatchBlock,
} from "../src/adapters/dsh";

async function makeHome(): Promise<{ root: string; dshHome: string; somaHome: string }> {
  const root = await mkdtemp(join(tmpdir(), "soma-dsh-plugin-"));
  const dshHome = join(root, ".dsh");
  const somaHome = join(root, ".soma");
  await mkdir(dshHome, { recursive: true });
  return { root, dshHome, somaHome };
}

const PATCH = {
  id: "soma-host",
  name: "@metafactory/soma-dsh-host",
  config: { writeDigests: true, somaPath: "/opt/bin/soma" },
};

test("cordis patch creates the file with a marker-guarded insert row", async () => {
  const { root, dshHome } = await makeHome();
  try {
    const target = await configureDshCordisPatch(dshHome, "web", PATCH);
    expect(target).toBe(join(dshHome, "profiles/web/cordis.patch.yml"));

    const content = await readFile(target, "utf8");
    expect(content).toContain(DSH_CORDIS_PATCH_BEGIN);
    expect(content).toContain(DSH_CORDIS_PATCH_END);
    expect(content).toContain("- insert:");
    expect(content).toContain("id: soma-host");
    expect(content).toContain('name: "@metafactory/soma-dsh-host"');
    expect(content).toContain('somaPath: "/opt/bin/soma"');
    // The managed block is the whole document — no bare `[]` placeholder left.
    expect(content).not.toMatch(/^\[\]\s*$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cordis patch replaces a bare [] placeholder and preserves foreign comments", async () => {
  const { root, dshHome } = await makeHome();
  try {
    const target = join(dshHome, "profiles/web/cordis.patch.yml");
    await mkdir(join(dshHome, "profiles/web"), { recursive: true });
    await writeFile(
      target,
      "# Your patch layer for this dsh profile:\n# a top-level YAML array.\n[]\n",
      "utf8",
    );

    await configureDshCordisPatch(dshHome, "web", PATCH);

    const content = await readFile(target, "utf8");
    expect(content).toContain("# Your patch layer for this dsh profile:");
    expect(content).not.toContain("[]");
    expect(content).toContain("- insert:");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cordis patch is byte-stable on re-run and updates config in place", async () => {
  const { root, dshHome } = await makeHome();
  try {
    const first = await readFile(await configureDshCordisPatch(dshHome, "web", PATCH), "utf8");
    const second = await readFile(
      await configureDshCordisPatch(dshHome, "web", { ...PATCH, config: { writeDigests: true, somaPath: "/new/soma" } }),
      "utf8",
    );
    expect(second).toContain('somaPath: "/new/soma"');
    expect(second).not.toContain("/opt/bin/soma");
    // Re-running with identical inputs must not change a byte.
    const third = await readFile(await configureDshCordisPatch(dshHome, "web", { ...PATCH, config: { writeDigests: true, somaPath: "/new/soma" } }), "utf8");
    expect(third).toBe(second);
    expect(first).not.toBe(second);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cordis patch strips a legacy hand-written row instead of double-inserting", async () => {
  const { root, dshHome } = await makeHome();
  try {
    const target = join(dshHome, "profiles/web/cordis.patch.yml");
    await mkdir(join(dshHome, "profiles/web"), { recursive: true });
    await writeFile(
      target,
      [
        "# header comment",
        "- insert:",
        "    - id: soma-host",
        "      name: '@metafactory/soma-dsh-host'",
        "      config:",
        "        writeDigests: true",
        "        somaPath: /Users/fischer/bin/soma",
        "",
      ].join("\n"),
      "utf8",
    );

    await configureDshCordisPatch(dshHome, "web", PATCH);

    const content = await readFile(target, "utf8");
    // Exactly one insert row remains, inside markers.
    expect(content.match(/- insert:/g)?.length).toBe(1);
    expect(content.indexOf("id: soma-host")).toBeGreaterThan(content.indexOf(DSH_CORDIS_PATCH_BEGIN));
    expect(content.match(new RegExp(DSH_CORDIS_PATCH_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cordis patch appends after genuine user rows", async () => {
  const { root, dshHome } = await makeHome();
  try {
    const target = join(dshHome, "profiles/web/cordis.patch.yml");
    await mkdir(join(dshHome, "profiles/web"), { recursive: true });
    await writeFile(target, "- override:\n    - id: llm\n      disabled: true\n", "utf8");

    await configureDshCordisPatch(dshHome, "web", PATCH);

    const content = await readFile(target, "utf8");
    expect(content.indexOf("id: llm")).toBeLessThan(content.indexOf(DSH_CORDIS_PATCH_BEGIN));
    expect(content.match(/- (insert|override):/g)?.length).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cordis unpatch removes the block and restores the [] placeholder", async () => {
  const { root, dshHome } = await makeHome();
  try {
    await configureDshCordisPatch(dshHome, "web", PATCH);
    expect(await removeDshCordisPatchBlock(dshHome, "web")).toBe(join(dshHome, "profiles/web/cordis.patch.yml"));
    const content = await readFile(join(dshHome, "profiles/web/cordis.patch.yml"), "utf8");
    expect(content.trim()).toBe("[]");

    // No block → null; foreign rows survive unpatching.
    expect(await removeDshCordisPatchBlock(dshHome, "web")).toBeNull();
    await configureDshCordisPatch(dshHome, "web", PATCH);
    await writeFile(join(dshHome, "profiles/web/cordis.patch.yml"), "- override:\n    - id: x\n\n" + (await readFile(join(dshHome, "profiles/web/cordis.patch.yml"), "utf8")), "utf8");
    await removeDshCordisPatchBlock(dshHome, "web");
    expect(await readFile(join(dshHome, "profiles/web/cordis.patch.yml"), "utf8")).toContain("id: x");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host plugin install skips without a composed profile", async () => {
  const { root, dshHome, somaHome } = await makeHome();
  try {
    const { notes, files } = await installDshHostPlugin({ dshHome, somaHome });
    expect(notes[0]).toContain("skipped soma-host");
    expect(files).toEqual([]);
    // Nothing landed anywhere.
    let missing = false;
    try {
      await readFile(join(somaHome, "integrations/dsh/soma-host/package.json"), "utf8");
    } catch {
      missing = true;
    }
    expect(missing).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host plugin install copies from the running soma package, wires pnpm, then patches", async () => {
  const { root, dshHome, somaHome } = await makeHome();
  try {
    await mkdir(join(dshHome, "profiles/web"), { recursive: true });
    await writeFile(
      join(dshHome, "profiles/web/package.json"),
      JSON.stringify({ name: "dsh-profile-web", private: true, dependencies: {}, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } }),
      "utf8",
    );
    await writeFile(join(dshHome, "profiles/web/cordis.patch.yml"), "[]\n", "utf8");

    const pnpmCalls: { args: string[]; cwd: string }[] = [];
    const { notes, files } = await installDshHostPlugin({
      dshHome,
      somaHome,
      somaBin: "/installed/soma",
      runPnpm: async (args, cwd) => {
        pnpmCalls.push({ args, cwd });
        return { exitCode: 0, stderr: "" };
      },
    });

    // Copy came from the running package's integrations/ dir.
    const copied = await readFile(join(somaHome, "integrations/dsh/soma-host/package.json"), "utf8");
    expect(JSON.parse(copied).name).toBe("@metafactory/soma-dsh-host");
    expect(dshHostPluginDestination(somaHome)).toBe(join(somaHome, "integrations/dsh/soma-host"));

    // pnpm ran in the profile dir against the COPY (never the dev checkout).
    expect(pnpmCalls.length).toBe(1);
    expect(pnpmCalls[0].cwd).toBe(join(dshHome, "profiles/web"));
    expect(pnpmCalls[0].args).toEqual(["add", "-w", `file:${join(somaHome, "integrations/dsh/soma-host")}`]);

    // Patch row written last, pointing at the given soma binary.
    const patch = await readFile(join(dshHome, "profiles/web/cordis.patch.yml"), "utf8");
    expect(patch).toContain('somaPath: "/installed/soma"');
    expect(notes.filter((note) => note.startsWith("WARNING"))).toEqual([]);
    expect(files).toEqual([join(dshHome, "profiles/web/cordis.patch.yml")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host plugin install failure leaves cordis.patch.yml untouched", async () => {
  const { root, dshHome, somaHome } = await makeHome();
  try {
    await mkdir(join(dshHome, "profiles/web"), { recursive: true });
    await writeFile(join(dshHome, "profiles/web/package.json"), "{}", "utf8");
    await writeFile(join(dshHome, "profiles/web/cordis.patch.yml"), "[]\n", "utf8");

    const { notes, files } = await installDshHostPlugin({
      dshHome,
      somaHome,
      runPnpm: async () => ({ exitCode: 1, stderr: "ERR_PNPM_NOOP" }),
    });
    expect(files).toEqual([]);

    expect(notes.some((note) => note.startsWith("WARNING"))).toBe(true);
    expect(notes.join("\n")).toContain("left untouched");
    // The copy still happened (it is cheap), but the composition was not touched.
    expect(await readFile(join(dshHome, "profiles/web/cordis.patch.yml"), "utf8")).toBe("[]\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
