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

function privateRoots(somaHome: string, homeDir?: string): string[] {
  const home = resolve(homeDir ?? homedir());

  return [
    join(somaHome, "profile"),
    join(somaHome, "memory"),
    join(home, ".codex", "memories", "soma"),
    join(home, ".codex", "skills", "soma"),
    join(home, ".pi", "agent", "soma"),
    join(home, ".pi", "agent", "skills", "soma"),
  ].map((path) => resolve(path));
}

function markerFor(path: string): string {
  return path.replace(homedir(), "~");
}

function privateMarkers(somaHome: string, homeDir?: string): string[] {
  const roots = privateRoots(somaHome, homeDir);
  return Array.from(new Set(roots.flatMap((root) => [root, markerFor(root)]))).sort((left, right) => right.length - left.length);
}

function findPrivateMarkers(content: string, somaHome: string, homeDir?: string): SomaPolicyFinding[] {
  if (!content) return [];

  return privateMarkers(somaHome, homeDir)
    .filter((marker) => content.includes(marker))
    .map((marker) => ({
      kind: "private-marker" as const,
      detail: marker,
    }));
}

export function evaluateSomaPolicy(options: SomaPolicyCheckOptions): SomaPolicyCheckResult {
  const somaHome = resolveSomaHome(options);
  const destinationPath = normalizePath(options.destinationPath);
  const sourcePath = options.sourcePath ? normalizePath(options.sourcePath) : undefined;
  const roots = privateRoots(somaHome, options.homeDir);
  const findings: SomaPolicyFinding[] = [];
  const destinationIsPublic = !roots.some((root) => isInside(destinationPath, root));

  if (destinationIsPublic && sourcePath && roots.some((root) => isInside(sourcePath, root))) {
    findings.push({
      kind: "private-source",
      detail: markerFor(sourcePath),
    });
  }

  if (destinationIsPublic) {
    findings.push(...findPrivateMarkers(options.content ?? "", somaHome, options.homeDir));
  }

  const decision = findings.length > 0 ? "deny" : "allow";
  const reason =
    decision === "deny"
      ? `Private Soma context cannot be written to public destination ${markerFor(destinationPath)}.`
      : `No private Soma source markers found for ${markerFor(destinationPath)}.`;

  return {
    somaHome,
    decision,
    reason,
    findings,
  };
}

export async function checkSomaPolicy(options: SomaPolicyCheckOptions): Promise<SomaPolicyCheckResult> {
  const result = evaluateSomaPolicy(options);
  const record = options.record ?? "all";

  if (record === "none" || (record === "deny" && result.decision !== "deny")) {
    return result;
  }

  const event = await appendSomaMemoryEvent(result.somaHome, {
    timestamp: options.timestamp,
    substrate: options.substrate ?? "custom",
    kind: "policy.check",
    summary: `${result.decision}: ${result.reason}`,
    artifactPaths: [normalizePath(options.destinationPath), ...(options.sourcePath ? [normalizePath(options.sourcePath)] : [])],
    metadata: {
      action: options.action,
      findings: result.findings,
    },
  });

  return {
    ...result,
    event,
  };
}
