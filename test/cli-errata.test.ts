import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appendErrata, errataLedgerPath } from "../src/errata";
import { parseErrataArgs } from "../src/cli/errata";
import { stageRuntimeArtifact } from "../src/runtime-artifact";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function cli(args: string[], entry = resolve(import.meta.dir, "../src/cli.ts")) {
  const child = Bun.spawn([process.execPath, entry, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

test("registered list/drop CLI implements veto and --all, unknown drop fails without append", async () => {
  const somaHome = await mkdtemp(join(tmpdir(), "soma-errata-cli-")); homes.push(somaHome);
  const input = { sessionId: "session", rejectedTurnUuid: "U2", rejectedAt: "2026-10-14T04:00:30Z", complaintAt: "2026-10-14T04:00:40Z", complaint: "private complaint", artifacts: ["src/a.ts"], passedBy: null };
  await appendErrata(somaHome, input);
  await appendErrata(somaHome, input);
  expect((await cli(["errata", "list", "--soma-home", somaHome])).stdout).toContain("E2\tactive");
  const drop = await cli(["errata", "drop", "E2", "--soma-home", somaHome]);
  expect(drop.exit).toBe(0);
  expect(drop.stdout).toContain("Dropped E2");
  const list = await cli(["errata", "list", "--json", "--soma-home", somaHome]);
  expect(list.exit).toBe(0);
  expect(JSON.parse(list.stdout).map((record: { id: string }) => record.id)).toEqual(["E1"]);
  const all = await cli(["errata", "list", "--all", "--json", "--soma-home", somaHome]);
  expect(JSON.parse(all.stdout).map((record: { status: string }) => record.status)).toEqual(["active", "dropped"]);
  const before = await readFile(errataLedgerPath(somaHome), "utf8");
  const unknown = await cli(["errata", "drop", "E99", "--soma-home", somaHome]);
  expect(unknown.exit).not.toBe(0);
  expect(unknown.stderr).toContain("Unknown Errata id");
  expect(await readFile(errataLedgerPath(somaHome), "utf8")).toBe(before);
});

test("Errata reads and vetoes from a standalone installed runtime without node_modules", async () => {
  const somaHome = await mkdtemp(join(tmpdir(), "soma-errata-runtime-")); homes.push(somaHome);
  const artifact = await stageRuntimeArtifact({ somaHome, target: "cli", sourceRoot: resolve(import.meta.dir, "..") });
  const entry = join(artifact.path, "src", "cli.ts");
  expect((await cli(["errata", "list", "--soma-home", somaHome], entry)).stdout).toContain("No Errata");
  await appendErrata(somaHome, { sessionId: "session", rejectedTurnUuid: "U2", rejectedAt: "2026-10-14T04:00:30Z", complaintAt: "2026-10-14T04:00:40Z", complaint: "private complaint", artifacts: ["src/a.ts"], passedBy: null });
  expect((await cli(["errata", "drop", "E1", "--soma-home", somaHome], entry)).exit).toBe(0);
  const all = await cli(["errata", "list", "--all", "--json", "--soma-home", somaHome], entry);
  expect(all.exit).toBe(0);
  expect(JSON.parse(all.stdout)[0].status).toBe("dropped");
});

test("Errata help and argument validation", async () => {
  expect((await cli(["errata", "--help"])).stdout).toContain("list|drop");
  expect((await cli(["errata", "drop", "--help"])).stdout).toContain("E<n>");
  expect(() => parseErrataArgs(["errata", "drop", "../E2"])).toThrow();
  expect(() => parseErrataArgs(["errata", "drop", "E2", "--all"])).toThrow();
  expect(() => parseErrataArgs(["errata", "list", "--soma-home"])).toThrow();
});
