/**
 * Issue 306 — `migrate-pai` regex assumed one-bullet-per-field for
 * DA_IDENTITY.md. PAI 5.0 packs `**Name:**`, `**Full Name:**`, and
 * other DA fields onto a single bullet separated by `|`. The greedy
 * `(.+)` capture either slurped the rest of the line as garbage or
 * fell through to the "Ivy" default.
 *
 * Fix: tighten captures to `([^|\n]+)` so they stop at the next field
 * separator. Backward compatible with the one-bullet-per-field shape.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { importPaiIdentity } from "../src/index";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-306-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function writePaiSkeleton(homeDir: string, daIdentity: string): Promise<void> {
  const userRoot = join(homeDir, ".claude/PAI/USER");
  await mkdir(join(userRoot, "TELOS"), { recursive: true });

  await writeFile(
    join(userRoot, "PRINCIPAL_IDENTITY.md"),
    [
      "# Principal Identity",
      "",
      "- **Name:** Rob Chuvala",
      "- **Pronunciation:** Rob CHEW-vall-uh",
      "- **Location:** Madison, Wisconsin",
      "- **Timezone:** America/Chicago",
      "- **Role:** Security Solutions Architect",
      "- **Focus:** Voice fidelity tools",
    ].join("\n"),
    "utf8",
  );

  await writeFile(join(userRoot, "DA_IDENTITY.md"), daIdentity, "utf8");

  const telosFixtures = [
    { file: "MISSION.md", content: "# Mission\n\nFixture mission line.\n" },
    { file: "GOALS.md", content: "# Goals\n\n- Fixture goal one.\n- Fixture goal two.\n" },
    { file: "BELIEFS.md", content: "# Beliefs\n\n- Fixture belief.\n" },
  ];

  for (const fixture of telosFixtures) {
    await writeFile(join(userRoot, "TELOS", fixture.file), fixture.content, "utf8");
  }
}

test("#306 pipe-separated DA_IDENTITY fields parse without leaking the Ivy default", async () => {
  await withTempHome(async (homeDir) => {
    const pipeSeparated = [
      "# DA Identity",
      "",
      "- **Name:** Margin | **Full Name:** Margin | **Display Name:** Margin | **Role:** Close-reader instance on Lares",
      "- **Color:** #1F2937 | **Voice ID:** voice-margin-001 | **Operating Environment:** Linux WSL2",
    ].join("\n");

    await writePaiSkeleton(homeDir, pipeSeparated);
    await importPaiIdentity({ homeDir });

    const assistant = await readFile(join(homeDir, ".soma/profile/assistant.md"), "utf8");

    // The whole point of #306 — the Ivy default must NOT leak through.
    expect(assistant).not.toContain("Ivy - Personal AI Assistant");
    expect(assistant).not.toContain("- full_name: Ivy");

    // Field captures must stop at the next `|` so the rest of the bullet
    // does not become part of the captured value.
    expect(assistant).toContain("Name: Margin");
    expect(assistant).toContain("Display name: Margin");
    expect(assistant).toContain("- full_name: Margin");
    expect(assistant).toContain("- role: Close-reader instance on Lares");
    expect(assistant).toContain("- color: #1F2937");
    expect(assistant).toContain("- voice_id: voice-margin-001");
    expect(assistant).toContain("- operating_environment: Linux WSL2");

    // Mid-line markup must never appear in captured values.
    expect(assistant).not.toContain("Margin | **Full Name:**");
    expect(assistant).not.toContain("**Display Name:** Margin");
  });
});

test("#306 one-bullet-per-field DA_IDENTITY still parses (backward compatible)", async () => {
  await withTempHome(async (homeDir) => {
    const onePerLine = [
      "# DA Identity",
      "",
      "- **Full Name:** Ivy - Personal AI Assistant",
      "- **Name:** Ivy",
      "- **Display Name:** Ivy",
      "- **Color:** #3B82F6",
      "- **Voice ID:** voice-123",
      "- **Role:** Jens-Christian's AI assistant",
      "- **Operating Environment:** Claude Code",
    ].join("\n");

    await writePaiSkeleton(homeDir, onePerLine);
    await importPaiIdentity({ homeDir });

    const assistant = await readFile(join(homeDir, ".soma/profile/assistant.md"), "utf8");

    expect(assistant).toContain("Name: Ivy");
    expect(assistant).toContain("Display name: Ivy");
    expect(assistant).toContain("- full_name: Ivy - Personal AI Assistant");
    expect(assistant).toContain("- color: #3B82F6");
    expect(assistant).toContain("- voice_id: voice-123");
    expect(assistant).toContain("- role: Jens-Christian's AI assistant");
    expect(assistant).toContain("- operating_environment: Claude Code");
  });
});

test("#306 principal profile fields also stop at pipes when present", async () => {
  await withTempHome(async (homeDir) => {
    const userRoot = join(homeDir, ".claude/PAI/USER");
    await mkdir(join(userRoot, "TELOS"), { recursive: true });

    // Some PAI installs pack principal-identity bullets the same way the
    // DA file does. The fix tightens those captures too.
    await writeFile(
      join(userRoot, "PRINCIPAL_IDENTITY.md"),
      [
        "# Principal Identity",
        "",
        "- **Name:** Rob Chuvala | **Pronunciation:** Rob CHEW-vall-uh | **Location:** Madison, Wisconsin",
        "- **Role:** Security Solutions Architect | **Focus:** Voice fidelity tools",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(userRoot, "DA_IDENTITY.md"),
      ["# DA Identity", "", "- **Name:** Margin", "- **Full Name:** Margin"].join("\n"),
      "utf8",
    );

    for (const file of ["MISSION.md", "GOALS.md", "BELIEFS.md"]) {
      await writeFile(join(userRoot, "TELOS", file), `# ${file}\n\nFixture body.\n`, "utf8");
    }

    await importPaiIdentity({ homeDir });

    const principal = await readFile(join(homeDir, ".soma/profile/principal.md"), "utf8");

    expect(principal).toContain("Name: Rob Chuvala");
    expect(principal).toContain("- pronunciation: Rob CHEW-vall-uh");
    expect(principal).toContain("- location: Madison, Wisconsin");
    expect(principal).toContain("- role: Security Solutions Architect");
    expect(principal).toContain("- focus: Voice fidelity tools");
    expect(principal).not.toContain("Rob Chuvala | **Pronunciation:**");
  });
});
