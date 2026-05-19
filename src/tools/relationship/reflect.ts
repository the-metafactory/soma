import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createPaths } from "../../paths";
import { addOpinion, addOpinionEvidence, listOpinions } from "../learning";
import type { EvidenceType } from "../learning";
import type { RelationshipMilestone, RelationshipNote, RelationshipReflectOptions, RelationshipReflectResult } from "./types";

const DEFAULT_MILESTONES = [
  { id: "first-pushback", description: "Principal pushed back on assistant", pattern: /pushed back|disagreed|challenged/i },
  { id: "genuine-unknown", description: "Assistant admitted genuine uncertainty", pattern: /don't know|do not know|not sure|uncertain/i },
  { id: "voice-smile", description: "Emotional response to voice interaction", pattern: /voice|smiled|laughed/i },
];

function pathsFor(options: RelationshipReflectOptions) {
  return createPaths(options.somaHome ? { somaHome: options.somaHome } : { homeDir: options.homeDir });
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function parseNoteLine(line: string, date: string, path: string): RelationshipNote | undefined {
  const match = line.match(/^\s*([WBO]):\s*(.+?)\s+(?:—|--|-)\s+(.+?)\s*$/);
  if (!match) return undefined;
  return {
    kind: match[1] as RelationshipNote["kind"],
    entity: match[2]!.trim(),
    observation: match[3]!.trim(),
    date,
    path,
  };
}

export function parseRelationshipNotes(content: string, date: string, path = ""): RelationshipNote[] {
  return content.split("\n")
    .map((line) => parseNoteLine(line, date, path))
    .filter((note): note is RelationshipNote => note !== undefined);
}

async function readDirIfExists(path: string) {
  return readdir(path, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
}

async function discoverNoteFiles(options: RelationshipReflectOptions): Promise<Array<{ path: string; date: string }>> {
  const paths = pathsFor(options);
  const now = options.now ?? new Date();
  const recentDays = options.recentDays ?? 7;
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - recentDays);
  const root = paths.relationship();
  const months = await readDirIfExists(root);
  const files: Array<{ path: string; date: string }> = [];
  for (const month of months.filter((entry) => entry.isDirectory())) {
    for (const entry of await readDirIfExists(join(root, month.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const date = basename(entry.name, ".md");
      if (new Date(`${date}T00:00:00.000Z`) < cutoff) continue;
      files.push({ path: join(root, month.name, entry.name), date });
    }
  }
  return files.sort((a, b) => a.date.localeCompare(b.date));
}

async function readRelationshipNotes(options: RelationshipReflectOptions): Promise<RelationshipNote[]> {
  const files = await discoverNoteFiles(options);
  const nested = await Promise.all(files.map(async (file) => {
    const content = await readFile(file.path, "utf8");
    return parseRelationshipNotes(content, file.date, file.path);
  }));
  return nested.flat();
}

function noteEvidenceType(note: RelationshipNote): EvidenceType {
  if (note.kind === "B") return "counter";
  return "supporting";
}

function applyDryRunConfidence(confidence: number, note: RelationshipNote): number {
  return Math.max(0.01, Math.min(0.99, confidence + (note.kind === "B" ? -0.05 : 0.02)));
}

async function emitConfidenceNotification(
  statement: string,
  oldConfidence: number,
  newConfidence: number,
  options: RelationshipReflectOptions,
): Promise<boolean> {
  const shouldNotify = Math.abs(newConfidence - oldConfidence) > 0.15;
  const notified = shouldNotify && Boolean(options.notifier) && !options.dryRun;
  if (notified && options.notifier) {
    await options.notifier.notify({
      title: "Relationship confidence shift",
      message: `${statement}: ${oldConfidence.toFixed(2)} -> ${newConfidence.toFixed(2)}`,
    });
  }
  return notified;
}

async function applyOpinionUpdates(notes: RelationshipNote[], options: RelationshipReflectOptions): Promise<RelationshipReflectResult["opinionUpdates"]> {
  const grouped = new Map<string, RelationshipNote[]>();
  for (const note of notes) {
    const group = grouped.get(note.entity);
    if (group) group.push(note);
    else grouped.set(note.entity, [note]);
  }
  const updates: RelationshipReflectResult["opinionUpdates"] = [];
  const cachedOpinions = new Map((await listOpinions(options)).map((opinion) => [opinion.statement.toLowerCase(), opinion]));

  for (const [statement, group] of grouped) {
    let existing = cachedOpinions.get(statement.toLowerCase());
    if (!existing && !options.dryRun) {
      existing = await addOpinion(statement, "relationship", options);
      cachedOpinions.set(statement.toLowerCase(), existing);
    }
    const oldConfidence = existing?.confidence ?? 0.5;
    let newConfidence = oldConfidence;

    for (const note of group) {
      if (options.dryRun) {
        newConfidence = applyDryRunConfidence(newConfidence, note);
        continue;
      }
      const result = await addOpinionEvidence(statement, noteEvidenceType(note), `${note.date}: ${note.observation}`, {
        ...options,
        sessionId: basename(note.path, ".md"),
      });
      newConfidence = result.opinion.confidence;
    }

    const notified = await emitConfidenceNotification(statement, oldConfidence, newConfidence, options);
    updates.push({ statement, oldConfidence, newConfidence, evidenceCount: group.length, notified });
  }

  return updates;
}

async function ratingsCount(options: RelationshipReflectOptions): Promise<number> {
  const content = await readFile(pathsFor(options).ratings(), "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  });
  return content.split("\n").filter((line) => line.trim()).length;
}

async function detectMilestones(notes: RelationshipNote[], options: RelationshipReflectOptions): Promise<RelationshipMilestone[]> {
  const now = isoDate(options.now ?? new Date());
  const milestones: RelationshipMilestone[] = [];
  const patterns = options.milestones ?? DEFAULT_MILESTONES;
  for (const milestone of patterns) {
    const note = notes.find((candidate) => milestone.pattern.test(candidate.observation));
    if (note) milestones.push({ id: milestone.id, description: milestone.description, evidence: note.observation, date: note.date });
  }
  if (await ratingsCount(options) >= 100) {
    milestones.push({ id: "100-sessions", description: "Centennial session milestone", evidence: "ratings count reached at least 100", date: now });
  }
  return milestones;
}

async function appendStoryMilestones(milestones: RelationshipMilestone[], options: RelationshipReflectOptions): Promise<string | undefined> {
  if (milestones.length === 0 || options.dryRun) return undefined;
  const path = pathsFor(options).story();
  const existing = await readFile(path, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "# Our Story\n\n";
    throw error;
  });
  const fresh = milestones.filter((milestone) => !existing.includes(`<!-- milestone:${milestone.id} -->`));
  if (fresh.length === 0) return path;
  const addition = fresh.map((milestone) => [
    `<!-- milestone:${milestone.id} -->`,
    `- ${milestone.date}: ${milestone.description} — ${milestone.evidence}`,
  ].join("\n")).join("\n");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${existing.trimEnd()}\n${addition}\n`, "utf8");
  return path;
}

export async function reflectRelationship(options: RelationshipReflectOptions = {}): Promise<RelationshipReflectResult> {
  const notes = await readRelationshipNotes(options);
  const opinionUpdates = options.milestonesOnly ? [] : await applyOpinionUpdates(notes, options);
  const milestones = options.opinionsOnly ? [] : await detectMilestones(notes, options);
  const storyPath = options.opinionsOnly ? undefined : await appendStoryMilestones(milestones, options);
  return { notes, opinionUpdates, milestones, storyPath, dryRun: options.dryRun ?? false };
}
