import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, spyOn, test } from "bun:test";
import { bootstrapSomaHome, loadSomaHome } from "../src/index";
import { projectClaudeCode } from "../src/adapters/claude-code";
import { projectCursor } from "../src/adapters/cursor";
import { projectAnthropicCoworkHome } from "../src/adapters/anthropic-cowork";
import { projectCodex } from "../src/adapters/codex/adapter";
import { projectDsh } from "../src/adapters/dsh/adapter";
import { projectGrok } from "../src/adapters/grok/adapter";
import { projectPiDev } from "../src/adapters/pi-dev/adapter";
import { renderAssistantCore } from "../src/adapters/shared";
import type { Projection } from "../src/types";
import { portableProjectionInput } from "./fixtures";

// soma#784 D9: Purpose's M0–Mn list is `missions`, read from `## Missions`,
// with `## Goals` kept as a silent load alias.

async function missionsFor(purposeBody: string, file = "purpose.md"): Promise<string[]> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-missions-"));
  try {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    if (file !== "purpose.md") await rm(join(somaHome, "profile/purpose.md"), { force: true });
    await writeFile(join(somaHome, "profile", file), `# Purpose\n\nMission: m\n\n${purposeBody}`, "utf8");
    return (await loadSomaHome(somaHome)).profile.purpose.missions;
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("## Missions loads into purpose.missions in order", async () => {
  expect(await missionsFor("## Missions\n\n- M0 first\n- M1 second\n- M2 third\n\n## Principles\n\n- p\n")).toEqual([
    "M0 first",
    "M1 second",
    "M2 third",
  ]);
});

test("a home with only ## Goals loads the same bullets, without a warning", async () => {
  const warn = spyOn(console, "warn");
  const error = spyOn(console, "error");
  try {
    expect(await missionsFor("## Goals\n\n- legacy one\n- legacy two\n")).toEqual(["legacy one", "legacy two"]);
    expect(await missionsFor("## Goals\n\n- from telos\n", "telos.md")).toEqual(["from telos"]);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
});

test("## Missions wins over ## Goals when both are present", async () => {
  expect(await missionsFor("## Goals\n\n- old\n\n## Missions\n\n- new\n")).toEqual(["new"]);
});

test("neither section yields no missions", async () => {
  expect(await missionsFor("## Principles\n\n- p\n")).toEqual([]);
});

test("the shared renderer prints the list under Missions", () => {
  const core = renderAssistantCore(portableProjectionInput);
  expect(core).toContain("Missions:\n- Prove context generation across substrates");
  expect(core).not.toMatch(/^Goals:$/m);
});

test("every adapter renders the list under a Missions heading, never Goals", () => {
  const bundles: Record<string, Projection> = {
    "claude-code": projectClaudeCode(portableProjectionInput),
    cursor: projectCursor(portableProjectionInput),
    "anthropic-cowork": projectAnthropicCoworkHome(portableProjectionInput),
    codex: projectCodex(portableProjectionInput),
    dsh: projectDsh(portableProjectionInput),
    grok: projectGrok(portableProjectionInput),
    "pi-dev": projectPiDev(portableProjectionInput),
  };
  for (const [name, bundle] of Object.entries(bundles)) {
    const texts = [bundle.instructions, ...bundle.files.map((file) => file.content)];
    const withBullet = texts.filter((text) => text.includes("- Prove context generation across substrates"));
    expect(withBullet.length, name).toBeGreaterThan(0);
    for (const text of withBullet) {
      expect(text, name).toMatch(/^(## Missions|Missions:)$/m);
      expect(text, name).not.toMatch(/^(## Goals|Goals:)$/m);
    }
  }
});
