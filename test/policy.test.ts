import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { bootstrapSomaHome, checkSomaPolicy, evaluateSomaPolicy, somaMemoryEventsPath } from "../src/index";
import { hasSomaPolicyPrivateMarker as hasSomaPolicyPrivateMarkerTs, renderPolicyMarkerMjs } from "../src/policy-marker";
import { hasSomaPolicyPrivateMarker as hasSomaPolicyPrivateMarkerJs } from "../src/adapters/policy-marker.mjs";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-policy-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("keeps TypeScript and hook marker matchers in parity", () => {
  const cases = [
    ["Copy ~/.soma/memory/private.md", "~/.soma"],
    ["Ignore ~/.soma-backup/private.md", "~/.soma"],
    ["JSON {\"path\":\"~/.soma\"}", "~/.soma"],
    ["/tmp/home/.soma2/file", "/tmp/home/.soma"],
    ["/tmp/home/.soma/file", "/tmp/home/.soma"],
  ] as const;

  for (const [content, marker] of cases) {
    expect(hasSomaPolicyPrivateMarkerJs(content, marker)).toBe(hasSomaPolicyPrivateMarkerTs(content, marker));
  }
});

test("keeps hook marker asset generated from TypeScript source", async () => {
  const asset = await readFile(join(import.meta.dir, "../src/adapters/policy-marker.mjs"), "utf8");
  expect(asset).toBe(renderPolicyMarkerMjs());
});

test("allows public writes without private Soma markers", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      substrate: "codex",
      action: "write",
      destinationPath: join(homeDir, "work/public/README.md"),
      content: "Generic public project notes.",
    });

    expect(result.decision).toBe("allow");
    expect(result.findings).toEqual([]);
  });
});

test("denies private Soma marker writes to public destinations", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      substrate: "codex",
      action: "write",
      destinationPath: join(homeDir, "work/public/README.md"),
      content: `Do not copy ${somaHome}/memory/RELATIONSHIP/private.md into public docs.`,
    });
    const events = await readFile(somaMemoryEventsPath(somaHome), "utf8");

    expect(result.decision).toBe("deny");
    expect(result.findings[0]).toMatchObject({
      kind: "private-marker",
    });
    expect(events).toContain("policy.check");
    expect(events).toContain("deny");
  });
});

test("allows private Soma marker writes inside private Soma destinations", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      action: "write",
      destinationPath: join(somaHome, "memory/WORK/private-note.md"),
      content: `${somaHome}/memory/RELATIONSHIP/private.md`,
    });

    expect(result.decision).toBe("allow");
  });
});

test("denies private source paths to public destinations", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      action: "write",
      destinationPath: join(homeDir, "work/public/summary.md"),
      sourcePath: join(somaHome, "profile/imports/claude/DA_IDENTITY.md"),
      content: "Summarized identity.",
    });

    expect(result.decision).toBe("deny");
    expect(result.findings[0]).toMatchObject({
      kind: "private-source",
    });
  });
});

test("treats the whole Soma home as private source material", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      action: "write",
      destinationPath: join(homeDir, "work/public/summary.md"),
      sourcePath: join(somaHome, "policy/README.md"),
      content: `Do not copy ${somaHome}/skills/README.md into public docs.`,
      record: "none",
    });

    expect(result.decision).toBe("deny");
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        kind: "private-source",
      }),
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        kind: "private-marker",
        detail: somaHome,
      }),
    );
  });
});

test("uses home-dir when detecting projected Codex private markers", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      action: "write",
      destinationPath: join(homeDir, "work/public/summary.md"),
      content: `${join(homeDir, ".codex/memories/soma/profile.md")} is projected private context.`,
    });

    expect(result.decision).toBe("deny");
    expect(result.findings[0]).toMatchObject({
      kind: "private-marker",
    });
  });
});

test("expands tilde paths from configured home-dir", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      action: "write",
      destinationPath: "~/work/public/summary.md",
      sourcePath: "~/.soma/profile/imports/claude/DA_IDENTITY.md",
      content: "Summarized identity.",
      record: "none",
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("~/work/public/summary.md");
    expect(result.findings[0]).toMatchObject({
      kind: "private-source",
    });
  });
});

test("detects configured-home tilde private markers in content", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      action: "write",
      destinationPath: "~/work/public/summary.md",
      content: "Do not publish ~/.soma/memory/RELATIONSHIP/private.md.",
      record: "none",
    });

    expect(result.decision).toBe("deny");
    expect(result.findings[0]).toMatchObject({
      kind: "private-marker",
      detail: "~/.soma",
    });
  });
});

test("does not treat private marker string prefixes as private paths", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      action: "write",
      destinationPath: "~/work/public/summary.md",
      content: "Public backup path: ~/.soma-backup/export.md.",
      record: "none",
    });

    expect(result.decision).toBe("allow");
  });
});

test("detects private markers followed by structured data delimiters", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      action: "write",
      destinationPath: "~/work/public/summary.md",
      content: 'Config includes { "path": "~/.soma" }.',
      record: "none",
    });

    expect(result.decision).toBe("deny");
  });
});

test("does not render tilde for paths that only share the home prefix", () => {
  const homeDir = "/tmp/soma-home";
  const result = evaluateSomaPolicy({
    homeDir,
    action: "write",
    destinationPath: "/tmp/soma-home2/public.md",
    content: "Generic public project notes.",
    record: "none",
  });

  expect(result.reason).toContain("/tmp/soma-home2/public.md");
  expect(result.reason).not.toContain("~2");
});

test("treats private-looking symlink destinations by their real public scope", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const publicDir = join(homeDir, "work/public");
    const publicFile = join(publicDir, "summary.md");
    const privateLookingLink = join(somaHome, "memory/WORK/public-summary.md");

    await mkdir(publicDir, { recursive: true });
    await writeFile(publicFile, "", "utf8");
    await symlink(publicFile, privateLookingLink);

    const result = await checkSomaPolicy({
      homeDir,
      action: "write",
      destinationPath: privateLookingLink,
      content: `${somaHome}/memory/RELATIONSHIP/private.md`,
    });

    expect(result.decision).toBe("deny");
    expect(result.findings[0]).toMatchObject({
      kind: "private-marker",
    });
  });
});

test("treats new paths under private symlinks by their real public scope", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const publicDir = join(homeDir, "work/public");
    const privateLookingLink = join(somaHome, "memory/WORK/public-dir");

    await mkdir(publicDir, { recursive: true });
    await symlink(publicDir, privateLookingLink);

    const result = await checkSomaPolicy({
      homeDir,
      action: "write",
      destinationPath: join(privateLookingLink, "new-summary.md"),
      content: `${somaHome}/memory/RELATIONSHIP/private.md`,
    });

    expect(result.decision).toBe("deny");
    expect(result.findings[0]).toMatchObject({
      kind: "private-marker",
    });
  });
});
