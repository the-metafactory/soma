import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathExists } from "../fs-utils";
import { installSpecFor } from "../install-spec-registry";
import { SKILL_MD } from "../skill-frontmatter";
import type { SomaDoctorFinding } from "../types";
import { isSkillStub, parseSkillStubBodyPath } from "./shared";
import type { SupportedDoctorSubstrate } from "./doctor";

/**
 * soma#542 — drift diagnosis for eager skill loaders.
 *
 * On an `on-demand` substrate a projected skill is a symlink, and a broken one
 * is visible to every tool that touches it. On an `eager` substrate it is a
 * generated stub whose whole purpose is a POINTER, and a pointer rots silently:
 * the loader still lists the skill, the agent still routes to it, and only when
 * it tries to read the body does it get a filesystem error instead of
 * instructions. Nothing else in the tree notices, because the stub itself is
 * perfectly well-formed.
 *
 * That happens whenever the registry slot moves out from under a stub — a skill
 * renamed, unprojected from the registry but not from the loader, or a soma home
 * relocated while a substrate home stayed put.
 *
 * Content-compare drift (soma#370) cannot catch this: it diffs projected bytes
 * against a fresh projection, and a stub pointing at a deleted body still
 * matches its own renderer exactly. The defect is in what the bytes REFER to,
 * so it needs a check that dereferences.
 */
export async function diagnoseSkillStubDrift(options: {
  substrate: SupportedDoctorSubstrate;
  homeDir: string;
  substrateHome?: string;
}): Promise<SomaDoctorFinding[]> {
  const spec = installSpecFor(options.substrate);
  // An on-demand substrate has no stubs to dangle. Keyed off the declared
  // capability rather than a substrate list, so a substrate that switches to
  // eager is covered without touching this file.
  if (spec.skillsLoading !== "eager") return [];

  const substrateHome = options.substrateHome
    ? resolve(options.substrateHome)
    : resolve(options.homeDir, spec.defaultHome);
  const loaderDir = spec.skillsLoaderDir(substrateHome);

  let entries;
  try {
    entries = await readdir(loaderDir, { withFileTypes: true });
  } catch {
    // No loader dir means nothing has been projected here. Absence of skills is
    // not drift — `soma install` reports that, and reporting it again as an
    // error would make a fresh home look broken.
    return [];
  }

  const dangling: { skill: string; body: string }[] = [];
  const unreadable: string[] = [];

  for (const entry of entries) {
    // Symlinks are the on-demand shape and the VSA/kernel skill is a real
    // projected dir; neither carries the stub marker, so both fall out below.
    if (!entry.isDirectory()) continue;

    const content = await readFile(join(loaderDir, entry.name, SKILL_MD), "utf8").catch(() => undefined);
    if (content === undefined || !isSkillStub(content)) continue;

    const body = parseSkillStubBodyPath(content);
    if (!body) {
      unreadable.push(entry.name);
      continue;
    }
    if (!(await pathExists(body))) dangling.push({ skill: entry.name, body });
  }

  const findings: SomaDoctorFinding[] = [];

  if (dangling.length > 0) {
    const names = dangling.map((entry) => entry.skill).sort();
    findings.push({
      id: "skill-stub-dangling",
      // An error, on the same footing as a missing projection file: the skill is
      // listed and routable but cannot be executed, which is worse than absent
      // because the agent commits to it before finding out.
      severity: "error",
      message:
        `${dangling.length} projected skill ${dangling.length === 1 ? "stub points" : "stubs point"} at a body that does not exist ` +
        `(${names.join(", ")}). The loader still lists ${dangling.length === 1 ? "it" : "them"}; reading the body fails.`,
      action:
        `Re-project the skill if its source still exists (soma project-skill <name> --substrate ${options.substrate} --apply), ` +
        `or remove the stale loader entry (soma unproject-skill <name> --substrate ${options.substrate} --apply).`,
    });
  }

  if (unreadable.length > 0) {
    findings.push({
      id: "skill-stub-unreadable",
      // Distinct from dangling: the pointer could not be READ, so we cannot say
      // whether a body exists. Hand-edited, or written by an older renderer.
      severity: "warning",
      message:
        `${unreadable.length} projected skill ${unreadable.length === 1 ? "stub carries" : "stubs carry"} the Soma marker but no readable body pointer ` +
        `(${[...unreadable].sort().join(", ")}).`,
      action: `soma project-skill <name> --substrate ${options.substrate} --apply --force`,
    });
  }

  return findings;
}
