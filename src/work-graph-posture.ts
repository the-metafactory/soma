/**
 * Operator posture — the one fact about a deployment the runtime cannot derive.
 *
 * §3.2's HITL close wants a 👍 from someone other than the proposal's author. On
 * a deployment operated by one person there is nobody else: `soma graph close
 * --propose` posts under their login, so every reaction available to them is a
 * self-ratification, and the node cannot close at all. That turns `attestation`
 * into a *gate* when §3.2 is explicit that it is a label.
 *
 * Two attempts to derive the condition failed review, and their failures are the
 * reason this file exists:
 *
 *   - **graph-root authorship** — self-conferred. `findGraphRoot` returns the
 *     node itself when it has no parent, so anyone who opens a parentless node
 *     holds the role.
 *   - **one reachable credential** — universal. Any contributor running a single
 *     personal token looks identical to a solo adopter, so it cannot tell one
 *     operator from one of fifty.
 *
 * "Am I the only person working here?" is a property of the *deployment*. Nothing
 * observable distinguishes it, so it is declared — by the adopter, once, in
 * soma-home, in the probe registry's shape and for the same reasons (§1 clause 5:
 * enforcement out of the agent's reach; §4: loosening is identity-bound and
 * fail-closed).
 *
 * **Per home, not per repo.** The claim is about who sits at this machine, and
 * that does not change because a map lives in a different repository. The probe
 * registry is repo-scoped because a *command* is only safe in context; an
 * operator is not a property of context.
 *
 * Absent, unparsable, or unreadable ⇒ **not declared**. A close on such a machine
 * refuses exactly as it does today.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Where the declaration sits inside soma-home. */
export const GRAPH_POSTURE_RELATIVE_PATH = "policy/graph-posture.json";

/** Only version this binary understands; an unknown one refuses rather than guessing. */
export const GRAPH_POSTURE_VERSION = 1;

export type GraphPosture =
  | { status: "declared"; path: string; singleOperator: boolean }
  | { status: "absent"; path: string }
  | { status: "invalid"; path: string; reason: string };

export interface GraphPostureHomeOptions {
  homeDir?: string;
  somaHome?: string;
}

export interface LoadGraphPostureOptions extends GraphPostureHomeOptions {
  /** Resolves to `undefined` when the document does not exist. Injected for tests. */
  readFile?: (path: string) => Promise<string | undefined>;
}

export function graphPosturePath(options: GraphPostureHomeOptions = {}): string {
  const home = resolve(options.homeDir ?? homedir());
  const somaHome = resolve(options.somaHome ?? join(home, ".soma"));
  return join(somaHome, GRAPH_POSTURE_RELATIVE_PATH);
}

async function defaultReadFile(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : undefined;
}

/** Never throws: an unreadable declaration is `invalid`, which does not declare anything. */
export async function loadGraphPosture(options: LoadGraphPostureOptions = {}): Promise<GraphPosture> {
  const path = graphPosturePath(options);
  const read = options.readFile ?? defaultReadFile;

  let raw: string | undefined;
  try {
    raw = await read(path);
  } catch (error) {
    return { status: "invalid", path, reason: `could not be read: ${describe(error)}` };
  }

  if (raw === undefined) return { status: "absent", path };
  return parseGraphPosture(path, raw);
}

export function parseGraphPosture(path: string, raw: string): GraphPosture {
  const invalid = (reason: string): GraphPosture => ({ status: "invalid", path, reason });

  let document: unknown;
  try {
    document = JSON.parse(raw) as unknown;
  } catch (error) {
    return invalid(`is not valid JSON: ${describe(error)}`);
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return invalid("must be a JSON object");
  }

  const record = document as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => key !== "version" && key !== "singleOperator");
  if (unknownKeys.length > 0) {
    return invalid(`has unknown key(s): ${unknownKeys.join(", ")} — expected only "version" and "singleOperator"`);
  }
  if (record.version !== GRAPH_POSTURE_VERSION) {
    return invalid(`must declare "version": ${GRAPH_POSTURE_VERSION} (found ${JSON.stringify(record.version)})`);
  }
  if (typeof record.singleOperator !== "boolean") {
    return invalid(`"singleOperator" must be true or false`);
  }

  return { status: "declared", path, singleOperator: record.singleOperator };
}

/**
 * Does this machine declare one operator? Everything except an explicit `true`
 * answers no — absence is not a claim.
 */
export function declaresSingleOperator(posture: GraphPosture | undefined): boolean {
  return posture?.status === "declared" && posture.singleOperator;
}

/** The document to write, for a refusal message that is copy-pasteable. */
export function renderStarterPosture(): string {
  return [`{`, `  "version": ${GRAPH_POSTURE_VERSION},`, `  "singleOperator": true`, `}`].join("\n");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
