import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { scanReleasePrivacy } from "../scripts/check-release-privacy";
import { withTempHome as withSharedTempHome } from "./fixtures/pai-migration-fixtures";

const withTempHome = <T>(fn: (homeDir: string) => Promise<T>): Promise<T> =>
  withSharedTempHome(fn, "soma-release-privacy-");

function hashPhrase(phrase: string): string {
  return createHash("sha256").update(phrase.toLowerCase()).digest("hex");
}

test("release privacy guard detects forbidden phrase hashes without storing plaintext defaults", async () => {
  await withTempHome(async (home) => {
    await mkdir(join(home, "bundle"), { recursive: true });
    await writeFile(
      join(home, "bundle", "TELOS.md"),
      "public text before private release fixture phrase after\n",
      "utf8",
    );

    const findings = await scanReleasePrivacy({
      root: home,
      files: ["bundle/TELOS.md"],
      forbiddenHashes: [
        {
          label: "fixture private phrase",
          sha256: hashPhrase("private release fixture phrase"),
        },
      ],
    });

    expect(findings).toEqual([
      {
        file: "bundle/TELOS.md",
        kind: "forbidden-hash",
        label: "fixture private phrase",
        line: 1,
      },
    ]);
  });
});

test("release privacy guard detects absolute private source roots", async () => {
  await withTempHome(async (home) => {
    await mkdir(join(home, "bundle"), { recursive: true });
    const privateRoot = "/Users/example/.claude" + "/PAI/USER";
    await writeFile(
      join(home, "bundle", "CONTEXT.md"),
      `source snapshot: ${privateRoot}/TELOS/MISSION.md\n`,
      "utf8",
    );

    const findings = await scanReleasePrivacy({
      root: home,
      files: ["bundle/CONTEXT.md"],
      forbiddenHashes: [],
    });

    expect(findings).toEqual([
      {
        file: "bundle/CONTEXT.md",
        kind: "private-marker",
        label: "absolute private PAI USER root",
        line: 1,
      },
    ]);
  });
});

test("release privacy guard accepts clean public files", async () => {
  await withTempHome(async (home) => {
    await mkdir(join(home, "bundle"), { recursive: true });
    await writeFile(join(home, "bundle", "README.md"), "clean public release text\n", "utf8");

    const findings = await scanReleasePrivacy({
      root: home,
      files: ["bundle/README.md"],
      forbiddenHashes: [],
    });

    expect(findings).toEqual([]);
  });
});

test("release privacy guard CLI rejects options without values", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "scripts/check-release-privacy.ts", "--root"],
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect(exitCode).toBe(2);
  expect(stdout).toBe("");
  expect(stderr).toContain("--root expects a value");
});
