/**
 * Proposal files — what a producer (Errata first) asks the principal to file as
 * a follow-up node (soma#903 D2, D6, D9).
 *
 * A proposal lives at `<soma-home>/proposals/<ref>.md`: typed front-matter, then
 * the markdown that becomes the node body. This module is the only place that
 * parses one — cortex runs `soma graph file-proposal <ref>` on approve and never
 * reads the file (D6) — so the schema, the path containment and the idempotency
 * marker live here together.
 */

import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { PROPOSAL_KINDS, type ProposalKind } from "../core/index";

import { buildBriefMissing, LIVE_PROBE } from "./build-brief";

/** The front-matter contract. Strict: a field this schema does not name is a producer bug, not an extension. */
export const proposalFrontMatterSchema = z.object({
  proposal_kind: z.enum(PROPOSAL_KINDS),
  landing: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, "must be owner/repo"),
  map_root: z.number().int().positive(),
  title: z.string().trim().min(1).regex(/^[^\r\n]*$/u, "must be one line"),
  checkpoint: z.string().regex(/^errata-[A-Za-z0-9][A-Za-z0-9._-]*$/u, "must be errata-<cluster-key>"),
  cites: z.array(z.string().regex(/^E[1-9]\d*$/u, "must be an Errata id E<n>")).min(1),
}).strict();
export type ProposalFrontMatter = z.infer<typeof proposalFrontMatterSchema>;

export interface ProposalFile {
  /** The proposal ref the marker names: the path under `proposals/`, without `.md`. */
  ref: string;
  path: string;
  frontMatter: ProposalFrontMatter;
  body: string;
}

/** What `file-proposal` hands to `soma graph add` (D9). */
export interface ProposalNodeSpec {
  title: string;
  kind: "build" | "grilling";
  autonomy: "propose" | "approve";
  checkpointId: string;
  body: string;
}

export class ProposalFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalFileError";
  }
}

const REF_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u;
const MARKER_PREFIX = "<!-- soma:proposal-ref: ";
const MARKER = /<!-- soma:proposal-ref: (\S+) -->/gu;

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * `soma:proposals/<ref>.md` (the envelope's form, D2) or a bare `<ref>`, which
 * resolves under `proposals/`. Percent-encoding is decoded first, so an encoded
 * `%2e%2e` meets the same containment check as a literal `..`.
 */
export async function resolveProposalPath(somaHome: string, proposalRef: string): Promise<{ ref: string; path: string }> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(proposalRef.trim());
  } catch {
    throw new ProposalFileError(`proposal ref ${JSON.stringify(proposalRef)} is not valid percent-encoding`);
  }
  if (decoded.length === 0 || decoded.includes("\0")) throw new ProposalFileError("proposal ref is empty or contains a NUL byte");

  const proposalsDir = join(resolve(somaHome), "proposals");
  const named = decoded.startsWith("soma:") ? resolve(somaHome, decoded.slice("soma:".length)) : resolve(proposalsDir, decoded);
  const path = named.endsWith(".md") ? named : `${named}.md`;
  const outside = new ProposalFileError(`proposal ref ${JSON.stringify(proposalRef)} resolves outside ${proposalsDir}${sep}`);
  if (!within(proposalsDir, path)) throw outside;

  const ref = relative(proposalsDir, path).slice(0, -".md".length).split(sep).join("/");
  if (!REF_KEY.test(ref)) throw new ProposalFileError(`proposal ref ${JSON.stringify(ref)} must be letters, digits, ".", "_" and "-", in "/"-separated segments`);

  let real: string;
  let realDir: string;
  try {
    real = await realpath(path);
    realDir = await realpath(proposalsDir);
  } catch {
    throw new ProposalFileError(`no proposal file at ${path}`);
  }
  // A symlink inside proposals/ that points out is refused the same as `..`.
  if (!within(realDir, real)) throw outside;
  if (!(await stat(real)).isFile()) throw new ProposalFileError(`${path} is not a regular file`);
  return { ref, path: real };
}

function splitFrontMatter(content: string): { frontMatter: string; body: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(content);
  return match ? { frontMatter: match[1], body: match[2] } : undefined;
}

/** Parse and validate one proposal's text; `ref` names the file in every refusal. */
export function parseProposal(ref: string, content: string): Omit<ProposalFile, "path"> {
  const parts = splitFrontMatter(content);
  if (parts === undefined) throw new ProposalFileError(`proposal ${ref}: missing --- front-matter block`);

  let raw: unknown;
  try {
    raw = Bun.YAML.parse(parts.frontMatter);
  } catch (error) {
    throw new ProposalFileError(`proposal ${ref}: front-matter is not YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = proposalFrontMatterSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => `${issue.path.join(".") || "front-matter"}: ${issue.message}`);
    throw new ProposalFileError(`proposal ${ref}: front-matter fails the schema — ${fields.join("; ")}`);
  }

  const body = parts.body.trim();
  if (body.length === 0) throw new ProposalFileError(`proposal ${ref}: the body below the front-matter is empty`);
  // A body that already names a ref would make the marker search match the wrong node.
  if (body.includes(MARKER_PREFIX)) throw new ProposalFileError(`proposal ${ref}: the body carries a proposal-ref marker; the verb writes that marker itself`);
  // Live probe readiness is reported by audit, not enforced at filing. For a
  // grilling node only the clarification marker applies, since it is no brief.
  const missing = buildBriefMissing(body).filter((entry) => entry !== LIVE_PROBE
    && (proposalNodeKind(parsed.data.proposal_kind) === "build" || entry === "[NEEDS CLARIFICATION]"));
  if (missing.length > 0) throw new ProposalFileError(`proposal ${ref}: build-brief-not-ready — ${missing.join(", ")}`);

  return { ref, frontMatter: parsed.data, body };
}

export async function readProposalFile(somaHome: string, proposalRef: string): Promise<ProposalFile> {
  const { ref, path } = await resolveProposalPath(somaHome, proposalRef);
  return { ...parseProposal(ref, await Bun.file(path).text()), path };
}

function proposalNodeKind(kind: ProposalKind): ProposalNodeSpec["kind"] {
  return kind === "deterministic-check" ? "build" : "grilling";
}

export function proposalMarker(ref: string): string {
  return `${MARKER_PREFIX}${ref} -->`;
}

/** True when the body carries this ref's marker — an exact ref, never a prefix of another. */
export function hasProposalMarker(body: string | undefined, ref: string): boolean {
  if (body === undefined) return false;
  return [...body.matchAll(MARKER)].some((match) => match[1] === ref);
}

/** D9: a deterministic check is buildable work; every other kind is a question for the principal. */
export function proposalNodeSpec(proposal: Pick<ProposalFile, "ref" | "frontMatter" | "body">): ProposalNodeSpec {
  const kind = proposalNodeKind(proposal.frontMatter.proposal_kind);
  return {
    title: proposal.frontMatter.title,
    kind,
    autonomy: kind === "build" ? "propose" : "approve",
    checkpointId: proposal.frontMatter.checkpoint,
    body: `${proposal.body}\n\n${proposalMarker(proposal.ref)}`,
  };
}
