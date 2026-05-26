import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { addOpinion, parseRelationshipNotes, reflectRelationship, type RelationshipNotification } from "../src";
import { runSomaCli } from "../src/cli";

async function withTempHome(fn: (homeDir: string, somaHome: string) => Promise<void>): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-relationship-"));
  await fn(homeDir, join(homeDir, ".soma"));
}

test("relationship note parsing maps WBO lines", () => {
  const notes = parseRelationshipNotes([
    "W: assistant — asked a sharp clarifying question",
    "B: assistant — missed the direct request",
    "O: collaboration — voice interaction felt natural",
  ].join("\n"), "2026-05-19", "/notes.md");

  expect(notes).toEqual([
    { kind: "W", entity: "assistant", observation: "asked a sharp clarifying question", date: "2026-05-19", path: "/notes.md" },
    { kind: "B", entity: "assistant", observation: "missed the direct request", date: "2026-05-19", path: "/notes.md" },
    { kind: "O", entity: "collaboration", observation: "voice interaction felt natural", date: "2026-05-19", path: "/notes.md" },
  ]);
});

test("relationship reflection updates opinions, detects milestones, and prevents duplicate story entries", async () => {
  await withTempHome(async (homeDir, somaHome) => {
    const noteDir = join(somaHome, "memory/RELATIONSHIP/2026-05");
    await mkdir(noteDir, { recursive: true });
    await writeFile(join(noteDir, "2026-05-19.md"), [
      "W: assistant — pushed back with useful evidence",
      "O: assistant — said do not know yet",
      "B: assistant — missed the direct request",
      "O: collaboration — voice exchange made the collaborator smile",
    ].join("\n"), "utf8");

    const result = await reflectRelationship({ homeDir, now: new Date("2026-05-20T12:00:00Z") });
    expect(result.notes).toHaveLength(4);
    expect(result.opinionUpdates.find((item) => item.statement === "assistant")?.evidenceCount).toBe(3);
    expect(result.milestones.map((item) => item.id)).toContain("first-pushback");
    expect(result.milestones.map((item) => item.id)).toContain("genuine-unknown");
    expect(result.milestones.map((item) => item.id)).toContain("voice-smile");

    const opinions = await readFile(join(somaHome, "identity/opinions.md"), "utf8");
    expect(opinions).toContain("assistant");
    expect(opinions).not.toContain(".claude");

    const storyPath = join(somaHome, "identity/our-story.md");
    const firstStory = await readFile(storyPath, "utf8");
    await reflectRelationship({ homeDir, now: new Date("2026-05-20T12:00:00Z") });
    const secondStory = await readFile(storyPath, "utf8");
    expect(secondStory.match(/milestone:first-pushback/g)?.length).toBe(1);
    expect(secondStory.length).toBe(firstStory.length);
  });
});

test("relationship reflection supports dry-run and notification injection", async () => {
  await withTempHome(async (homeDir, somaHome) => {
    await addOpinion("assistant", "relationship", { homeDir, initialConfidence: 0.5 });
    const noteDir = join(somaHome, "memory/RELATIONSHIP/2026-05");
    await mkdir(noteDir, { recursive: true });
    await writeFile(join(noteDir, "2026-05-19.md"), [
      "B: assistant — missed request one",
      "B: assistant — missed request two",
      "B: assistant — missed request three",
      "B: assistant — missed request four",
    ].join("\n"), "utf8");

    const dryRun = await reflectRelationship({ homeDir, dryRun: true, now: new Date("2026-05-20T12:00:00Z") });
    expect(dryRun.opinionUpdates[0]?.newConfidence).toBeCloseTo(0.3);
    expect(dryRun.opinionUpdates[0]?.notified).toBe(false);
    await expect(readFile(join(somaHome, "identity/our-story.md"), "utf8")).rejects.toThrow();

    const notifications: RelationshipNotification[] = [];
    const result = await reflectRelationship({
      homeDir,
      now: new Date("2026-05-20T12:00:00Z"),
      notifier: { notify: async (notification) => { notifications.push(notification); } },
    });
    expect(result.opinionUpdates[0]?.notified).toBe(true);
    expect(notifications).toHaveLength(1);
  });
});

test("relationship CLI reflects modes", async () => {
  await withTempHome(async (homeDir, somaHome) => {
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    const noteDir = join(somaHome, "memory/RELATIONSHIP", month);
    await mkdir(noteDir, { recursive: true });
    await writeFile(join(noteDir, `${today}.md`), "W: assistant — challenged the vague plan\n", "utf8");

    const full = await runSomaCli(["relationship", "reflect", "--home-dir", homeDir]);
    expect(full).toContain("relationship reflect");
    expect(full).toContain("milestones: 1");

    const dryRun = await runSomaCli(["relationship", "reflect", "--dry-run", "--opinions-only", "--home-dir", homeDir]);
    expect(dryRun).toContain("dry-run: no writes");

    await expect(runSomaCli(["relationship", "reflect", "--opinions-only", "--milestones-only", "--home-dir", homeDir])).rejects.toThrow("cannot be combined");
  });
});
