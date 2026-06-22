import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { evaluatePathGuard, SOMA_DEFAULT_PROTECTED_PATHS, SOMA_HOME_ALLOWED_MODIFY_SUBPATHS } from "./policy-path-guard";
import { hasSomaPolicyPrivateMarker } from "./policy-marker";
import { isInsidePath } from "./path-utils";
import type { SomaPolicyBatchCheckOptions, SomaPolicyBatchCheckResult, SomaPolicyBatchTarget, SomaPolicyCheckOptions, SomaPolicyCheckResult, SomaPolicyFinding, SomaProtectedPath } from "./types";

function resolveSomaHome(options: Pick<SomaPolicyCheckOptions, "homeDir" | "somaHome"> = {}): string {
  return resolve(options.somaHome ?? join(options.homeDir ?? homedir(), ".soma"));
}

export function normalizeSomaPolicyPath(path: string, baseDir = process.cwd(), homeDir?: string): string {
  const expanded = path.startsWith("~/") ? join(homeDir ?? homedir(), path.slice(2)) : path;
  return resolve(isAbsolute(expanded) ? expanded : join(baseDir, expanded));
}

function somaPolicyPrivateRoots(somaHome: string, privateRoots: string[] = []): string[] {
  return [somaHome, ...privateRoots].map((path) => resolve(path));
}

const SOMA_POLICY_PRIVATE_CONTENT_SUBPATHS = [
  "memory",
  "profile",
  "imports",
] as const;

const SOMA_POLICY_PORTABLE_MARKERS = [
  "~/.codex/memories/soma",
  "~/.codex/skills/soma",
  "~/.pi/agent/soma",
  "~/.pi/agent/skills/soma",
] as const;


interface SomaPolicyScope {
  destinationPath: string;
  destinationScopePath: string;
  sourcePath?: string;
  sourceScopePath?: string;
  roots: string[];
  rootScopes: string[];
  somaHome: string;
}

async function realScopePath(path: string): Promise<string> {
  let cursor = path;
  const suffix: string[] = [];

  while (!(await pathExists(cursor))) {
    const parent = dirname(cursor);
    if (parent === cursor) return path;
    suffix.unshift(cursor.slice(parent.length + 1));
    cursor = parent;
  }

  const realCursor = await realpath(cursor);
  return suffix.length > 0 ? resolve(realCursor, ...suffix) : realCursor;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function markerFor(path: string, homeDir?: string): string {
  const home = resolve(homeDir ?? homedir());
  const resolvedPath = resolve(path);

  if (!isInsidePath(resolvedPath, home)) {
    return path;
  }

  // Portable tilde markers are POSIX-shaped by definition: `relative()`
  // returns backslash separators on Windows, and a `~/.soma\memory`
  // marker would never match the `~/.soma/memory/...` form content
  // actually carries.
  const rel = relative(home, resolvedPath).split(sep).join("/");
  return rel === "" ? "~" : `~/${rel}`;
}

export function somaPolicyPrivateMarkers(somaHome: string, homeDir?: string, privateRoots: string[] = []): string[] {
  const roots = somaPolicyPrivateRoots(somaHome, privateRoots);
  const resolvedSomaHome = resolve(somaHome);
  const rootMarkers = roots.flatMap((root) => {
    if (root !== resolvedSomaHome) {
      return [root, markerFor(root, homeDir)];
    }
    return SOMA_POLICY_PRIVATE_CONTENT_SUBPATHS.flatMap((subpath) => {
      const sensitiveRoot = join(root, subpath);
      return [sensitiveRoot, markerFor(sensitiveRoot, homeDir)];
    });
  });
  return Array.from(new Set([...rootMarkers, ...SOMA_POLICY_PORTABLE_MARKERS])).sort((left, right) => right.length - left.length);
}

export { hasSomaPolicyPrivateMarker };

function findPrivateMarkers(content: string, somaHome: string, homeDir?: string, privateRoots: string[] = []): SomaPolicyFinding[] {
  if (!content) return [];

  return somaPolicyPrivateMarkers(somaHome, homeDir, privateRoots)
    .filter((marker) => hasSomaPolicyPrivateMarker(content, marker))
    .map((marker) => ({
      kind: "private-marker" as const,
      detail: marker,
    }));
}

function unresolvedPolicyScope(options: SomaPolicyCheckOptions): Omit<SomaPolicyScope, "destinationScopePath" | "sourceScopePath" | "rootScopes"> {
  const somaHome = resolveSomaHome(options);
  const cwd = options.cwd ?? process.cwd();
  const destinationPath = normalizeSomaPolicyPath(options.destinationPath, cwd, options.homeDir);
  const sourcePath = options.sourcePath ? normalizeSomaPolicyPath(options.sourcePath, cwd, options.homeDir) : undefined;
  const roots = somaPolicyPrivateRoots(somaHome, options.privateRoots);

  return {
    destinationPath,
    sourcePath,
    roots,
    somaHome,
  };
}

function evaluateResolvedSomaPolicy(options: SomaPolicyCheckOptions, scope: SomaPolicyScope): SomaPolicyCheckResult {
  const { destinationPath, destinationScopePath, sourcePath, sourceScopePath, roots, rootScopes, somaHome } = scope;

  // Path protection for delete/modify actions
  if (options.action === "delete" || options.action === "modify") {
    return evaluateResolvedSomaPathGuard({ ...options, action: options.action }, scope);
  }

  const findings: SomaPolicyFinding[] = [];
  const destinationIsPrivate = roots.some((root, index) => isInsidePath(destinationPath, root) && isInsidePath(destinationScopePath, rootScopes[index]));
  const destinationIsPublic = !destinationIsPrivate;

  if (destinationIsPublic && sourcePath && roots.some((root, index) => isInsidePath(sourcePath, root) || isInsidePath(sourceScopePath ?? sourcePath, rootScopes[index]))) {
    findings.push({
      kind: "private-source",
      detail: markerFor(sourcePath, options.homeDir),
    });
  }

  if (destinationIsPublic) {
    findings.push(...findPrivateMarkers(options.content ?? "", somaHome, options.homeDir, roots.filter((root) => root !== somaHome)));
  }

  const decision = findings.length > 0 ? "deny" : "allow";
  const reason =
    decision === "deny"
      ? `Private Soma context cannot be written to public destination ${markerFor(destinationPath, options.homeDir)}.`
      : `No private Soma source markers found for ${markerFor(destinationPath, options.homeDir)}.`;

  return {
    somaHome,
    decision,
    reason,
    findings,
  };
}

function evaluateResolvedSomaPathGuard(options: SomaPolicyCheckOptions & { action: "delete" | "modify" }, scope: SomaPolicyScope): SomaPolicyCheckResult {
  const { destinationPath, somaHome, roots } = scope;
  const cwd = options.cwd ?? process.cwd();

  // Convert all private roots to protected paths for delete/modify actions.
  // This ensures the somaHome itself is protected, not just user-specified paths.
  //
  // For the Soma home specifically, mirror the SOMA_DEFAULT_PROTECTED_PATHS
  // policy: allow modify on isa/ and memory/ subtrees so legitimate ISA and
  // memory writes pass `soma policy check --action modify` even when the
  // operator passes an explicit --soma-home. Delete remains blocked for the
  // whole tree (allowedSubpaths is modify-only).
  const rootProtectedPaths: SomaProtectedPath[] = roots.map((root) => ({
    path: root,
    description: `Soma private root: ${markerFor(root, options.homeDir)}`,
    ...(root === somaHome ? { allowedSubpaths: [...SOMA_HOME_ALLOWED_MODIFY_SUBPATHS] } : {}),
  }));
  const normalizeProtectedPaths = (protectedPaths: readonly SomaProtectedPath[]): SomaProtectedPath[] =>
    protectedPaths.map((protectedPath) => ({
      ...protectedPath,
      path: normalizeSomaPolicyPath(protectedPath.path, cwd, options.homeDir),
    }));
  const defaultProtectedPaths = normalizeProtectedPaths(SOMA_DEFAULT_PROTECTED_PATHS);
  const optionProtectedPaths = normalizeProtectedPaths(options.protectedPaths ?? []);

  const guardResult = evaluatePathGuard({
    targetPaths: [destinationPath],
    cwd,
    protectedPaths: [...defaultProtectedPaths, ...optionProtectedPaths, ...rootProtectedPaths],
    action: options.action,
  });

  const decision = guardResult.blocked ? "deny" : "allow";
  const reason = guardResult.blocked
    ? `${options.action} blocked on protected path ${markerFor(destinationPath, options.homeDir)}: ${guardResult.matchedDescriptions.join(", ")}.`
    : `${markerFor(destinationPath, options.homeDir)} is not a protected path.`;

  const findings: SomaPolicyFinding[] = guardResult.matchedPaths.map((path) => ({
    kind: "protected-path" as const,
    detail: `${markerFor(path, options.homeDir)} (${options.action})`,
  }));

  return {
    somaHome,
    decision,
    reason,
    findings,
  };
}

export function evaluateSomaPolicy(options: SomaPolicyCheckOptions): SomaPolicyCheckResult {
  const scope = unresolvedPolicyScope(options);

  return evaluateResolvedSomaPolicy(options, {
    ...scope,
    destinationScopePath: scope.destinationPath,
    sourceScopePath: scope.sourcePath,
    rootScopes: scope.roots,
  });
}

export async function evaluateSomaPolicyWithFilesystem(options: SomaPolicyCheckOptions, rootScopes?: string[]): Promise<SomaPolicyCheckResult> {
  const scope = unresolvedPolicyScope(options);

  return evaluateResolvedSomaPolicy(options, {
    ...scope,
    destinationScopePath: await realScopePath(scope.destinationPath),
    sourceScopePath: scope.sourcePath ? await realScopePath(scope.sourcePath) : undefined,
    rootScopes: rootScopes ?? (await Promise.all(scope.roots.map((root) => realScopePath(root)))),
  });
}

export async function evaluateSomaPolicyBatch(options: SomaPolicyBatchCheckOptions): Promise<SomaPolicyBatchCheckResult> {
  const somaHome = resolveSomaHome(options);
  const rootScopes = await Promise.all(somaPolicyPrivateRoots(somaHome, options.privateRoots).map((root) => realScopePath(root)));
  const results = await Promise.all(
    options.targets.map((target) => evaluateSomaPolicyWithFilesystem(policyOptionsForTarget(options, target), rootScopes)),
  );
  const denied = results.find((result) => result.decision === "deny");

  return {
    decision: denied ? "deny" : "allow",
    reason: denied?.reason ?? "No private Soma source markers found in batch.",
    results,
  };
}

export function policyOptionsForTarget(options: Omit<SomaPolicyBatchCheckOptions, "targets">, target: SomaPolicyBatchTarget): SomaPolicyCheckOptions {
  return {
    homeDir: options.homeDir,
    somaHome: options.somaHome,
    privateRoots: options.privateRoots,
    protectedPaths: options.protectedPaths,
    cwd: options.cwd,
    substrate: options.substrate,
    action: target.action ?? options.action,
    destinationPath: target.filePath,
    sourcePath: target.sourcePath,
    content: target.content,
    record: options.record,
    timestamp: options.timestamp,
  };
}
