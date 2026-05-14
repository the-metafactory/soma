import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { appendSomaMemoryEvent } from "./memory";
import type { SomaPolicyCheckOptions, SomaPolicyCheckResult, SomaPolicyFinding } from "./types";

function resolveSomaHome(options: Pick<SomaPolicyCheckOptions, "homeDir" | "somaHome"> = {}): string {
  return resolve(options.somaHome ?? join(options.homeDir ?? homedir(), ".soma"));
}

function normalizePath(path: string, baseDir = process.cwd()): string {
  const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  return resolve(isAbsolute(expanded) ? expanded : join(baseDir, expanded));
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function privateRoots(somaHome: string): string[] {
  const home = homedir();

  return [
    join(somaHome, "profile"),
    join(somaHome, "memory"),
    join(home, ".codex", "memories", "soma"),
    join(home, ".codex", "skills", "soma"),
    join(home, ".pi", "agent", "soma"),
    join(home, ".pi", "agent", "skills", "soma"),
  ].map((path) => resolve(path));
}

function publicDestination(path: string, somaHome: string): boolean {
  return !privateRoots(somaHome).some((root) => isInside(path, root));
}

function markerFor(path: string): string {
  return path.replace(homedir(), "~");
}

function privateMarkers(somaHome: string): string[] {
  const roots = privateRoots(somaHome);
  return Array.from(new Set(roots.flatMap((root) => [root, markerFor(root)]))).sort((left, right) => right.length - left.length);
}

function findPrivateMarkers(content: string, somaHome: string): SomaPolicyFinding[] {
  if (!content) return [];

  return privateMarkers(somaHome)
    .filter((marker) => content.includes(marker))
    .map((marker) => ({
      kind: "private-marker" as const,
      detail: marker,
    }));
}

export async function checkSomaPolicy(options: SomaPolicyCheckOptions): Promise<SomaPolicyCheckResult> {
  const somaHome = resolveSomaHome(options);
  const destinationPath = normalizePath(options.destinationPath);
  const sourcePath = options.sourcePath ? normalizePath(options.sourcePath) : undefined;
  const findings: SomaPolicyFinding[] = [];
  const destinationIsPublic = publicDestination(destinationPath, somaHome);

  if (destinationIsPublic && sourcePath && privateRoots(somaHome).some((root) => isInside(sourcePath, root))) {
    findings.push({
      kind: "private-source",
      detail: markerFor(sourcePath),
    });
  }

  if (destinationIsPublic) {
    findings.push(...findPrivateMarkers(options.content ?? "", somaHome));
  }

  const decision = findings.length > 0 ? "deny" : "allow";
  const reason =
    decision === "deny"
      ? `Private Soma context cannot be written to public destination ${markerFor(destinationPath)}.`
      : `No private Soma source markers found for ${markerFor(destinationPath)}.`;
  const event = await appendSomaMemoryEvent(somaHome, {
    timestamp: options.timestamp,
    substrate: options.substrate ?? "custom",
    kind: "policy.check",
    summary: `${decision}: ${reason}`,
    artifactPaths: [destinationPath, ...(sourcePath ? [sourcePath] : [])],
    metadata: {
      action: options.action,
      findings,
    },
  });

  return {
    somaHome,
    decision,
    reason,
    findings,
    event,
  };
}
