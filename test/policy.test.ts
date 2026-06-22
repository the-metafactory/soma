import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { bootstrapSomaHome, checkSomaPolicy, evaluateSomaPolicy, somaMemoryEventsPath } from "../src/index";
import { somaPolicyPrivateMarkers } from "../src/policy";
import { hasSomaPolicyPrivateMarker as hasSomaPolicyPrivateMarkerTs, renderPolicyMarkerMjs } from "../src/policy-marker";
import { hasSomaPolicyPrivateMarker as hasSomaPolicyPrivateMarkerJs } from "../src/adapters/codex/hooks/policy-marker.mjs";

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
  const asset = await readFile(join(import.meta.dir, "../src/adapters/codex/hooks/policy-marker.mjs"), "utf8");
  expect(asset).toBe(renderPolicyMarkerMjs());
});

test("renders portable tilde markers POSIX-shaped on every platform", async () => {
  await withTempHome(async (homeDir) => {
    // `relative()` returns backslash separators on Windows; a marker like
    // `~/.soma\memory` would never match the `~/.soma/memory/...` form
    // content actually carries, silently disabling portable-marker
    // detection on Windows installs.
    const markers = somaPolicyPrivateMarkers(join(homeDir, ".soma"), homeDir);
    const tildeMarkers = markers.filter((marker) => marker.startsWith("~"));
    expect(tildeMarkers.length).toBeGreaterThan(0);
    for (const marker of tildeMarkers) {
      expect(marker).not.toContain("\\");
    }
    expect(tildeMarkers).toContain("~/.soma/memory");
  });
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

test("allows generic Soma home mentions in public docs and tests", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    const genericHome = "~/" + ".soma";
    const result = await checkSomaPolicy({
      homeDir,
      substrate: "codex",
      action: "write",
      destinationPath: join(homeDir, "work/public/paths.test.ts"),
      content: `test("createPaths defaults to ${genericHome} under homeDir", () => {})`,
      record: "none",
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
  });
});

test("uses home-dir when detecting projected Codex private markers", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      substrate: "codex",
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

test("allows private markers in approved Codex memory destinations", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      substrate: "codex",
      action: "write",
      destinationPath: join(homeDir, ".codex/memories/MEMORY.md"),
      content: `${join(homeDir, ".codex/memories/soma/startup-context.md")} is operational memory metadata.`,
      record: "none",
    });

    expect(result.decision).toBe("allow");
  });
});

test("allows private markers in approved Claude memory destinations", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      substrate: "claude-code",
      privateRoots: [join(homeDir, ".claude/memories")],
      action: "write",
      destinationPath: join(homeDir, ".claude/memories/session.md"),
      content: `${join(homeDir, ".soma/memory/WORK/private.md")} is allowed inside managed memory.`,
      record: "none",
    });

    expect(result.decision).toBe("allow");
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
      detail: "~/" + ".soma/memory",
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

test("allows generic Soma home markers followed by structured data delimiters", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    const genericHome = "~/" + ".soma";
    const result = await checkSomaPolicy({
      homeDir,
      action: "write",
      destinationPath: "~/work/public/summary.md",
      content: `Config includes { "path": "${genericHome}" }.`,
      record: "none",
    });

    expect(result.decision).toBe("allow");
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
