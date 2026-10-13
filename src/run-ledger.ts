/**
 * Soma's run ledger (node #820): the one funnel that turns a finished run into
 * an `execution.run.finished` envelope on the bus.
 *
 * Every soma producer calls `publishRunFinished`. The Algorithm CLI is the first
 * caller; a general `soma run finished` verb is meant to be the second. The
 * funnel owns the bus environment (`SOMA_*`, `MF_*`), the myelin builder, the
 * outbox and the 2000 ms ceiling, so no caller repeats them.
 *
 * Delivery fails open: a run that finished stays finished whether or not the
 * bus heard about it. A failure is recorded as one `run_ledger.publish_failed`
 * event and never thrown. With `SOMA_PRINCIPAL` unset nothing is built, no
 * connection is opened and no spool is touched.
 *
 * myelin is imported lazily, like zod in `goal-records`: most soma invocations
 * never emit, and a home without bus config should not pay the module load.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type {
  ExecutionRunFinishedEvent,
  ExecutionRunServes,
  MyelinEnvelope,
  RunKind,
  RunOutcome,
  Sovereignty,
  TransportPublisher,
} from "@the-metafactory/myelin";
import { appendSomaMemoryEvent } from "./memory";
import { createPaths } from "./paths";
import { RUN_LEDGER_ENV } from "./run-ledger-env";
import type { SubstrateId } from "./types";

// Callers name run kinds and outcomes through the funnel, not through myelin.
export type { RunKind, RunOutcome };

/** The whole emit — load, build, connect, drain, publish, close — gives up after this. */
export const RUN_LEDGER_TIMEOUT_MS = 2000;

/** Reflex's defaults: the envelope stays on the principal's own bus. */
export const RUN_LEDGER_SOVEREIGNTY: Sovereignty = {
  classification: "local",
  data_residency: "CH",
  max_hop: 0,
  frontier_ok: false,
  model_class: "any",
};

const DEFAULT_STACK = "default";
const DEFAULT_NATS_URL = "nats://127.0.0.1:4222";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export type RunLedgerEnv = Readonly<Record<string, string | undefined>>;

/** What a finished run reports. The funnel adds producer, correlation and, unless given, serves. */
export interface RunFinishedInput {
  kind: RunKind;
  ref: string;
  runId: string;
  outcome: RunOutcome;
  startedAt: string;
  endedAt: string;
  detailRef?: string;
  /** Overrides `MF_SERVES_GOAL` / `MF_SERVES_NODE` when set. */
  serves?: ExecutionRunServes;
}

/** Sends one built event. The default goes through myelin's outbox over NATS. */
export type RunFinishedPublisher = (event: ExecutionRunFinishedEvent) => Promise<void>;

export interface PublishRunFinishedOptions {
  somaHome: string;
  /** Attribution for the failure event. */
  substrate: SubstrateId;
  env?: RunLedgerEnv;
  publish?: RunFinishedPublisher;
}

export type RunFinishedResult = "disabled" | "published" | "failed";

type RunLedgerStage = "load" | "build" | "config" | "publish" | "timeout";

class RunLedgerError extends Error {
  constructor(
    readonly stage: RunLedgerStage,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface RunLedgerConfig {
  principal: string;
  stack: string;
  natsUrl: string;
  natsCreds?: string;
  correlationId?: string;
  serves?: ExecutionRunServes;
}

function setting(env: RunLedgerEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** `undefined` when `SOMA_PRINCIPAL` is unset or empty: the ledger is off. */
function readRunLedgerConfig(env: RunLedgerEnv): RunLedgerConfig | undefined {
  const principal = setting(env, RUN_LEDGER_ENV.principal);
  if (principal === undefined) return undefined;
  const goal = setting(env, RUN_LEDGER_ENV.servesGoal);
  const node = setting(env, RUN_LEDGER_ENV.servesNode);
  const serves = goal === undefined && node === undefined
    ? undefined
    : { ...(goal === undefined ? {} : { goal }), ...(node === undefined ? {} : { node }) };
  return {
    principal,
    stack: setting(env, RUN_LEDGER_ENV.stack) ?? DEFAULT_STACK,
    natsUrl: setting(env, RUN_LEDGER_ENV.natsUrl) ?? DEFAULT_NATS_URL,
    natsCreds: setting(env, RUN_LEDGER_ENV.natsCreds),
    correlationId: setting(env, RUN_LEDGER_ENV.correlationId),
    serves,
  };
}

export function runLedgerSpoolPath(somaHome: string): string {
  return createPaths(somaHome).state("run-ledger", "outbox.jsonl");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadMyelin(): Promise<typeof import("@the-metafactory/myelin")> {
  try {
    return await import("@the-metafactory/myelin");
  } catch (error) {
    throw new RunLedgerError("load", `could not load @the-metafactory/myelin: ${errorMessage(error)}`, { cause: error });
  }
}

/** The envelope that goes on the wire for a built event: reflex sovereignty under the event's own. */
export async function buildRunFinishedEnvelope(event: ExecutionRunFinishedEvent): Promise<MyelinEnvelope> {
  const { createEnvelope, validateEnvelope } = await loadMyelin();
  const envelope = createEnvelope({
    ...event.input,
    sovereignty: { ...RUN_LEDGER_SOVEREIGNTY, ...event.input.sovereignty },
  });
  const validation = validateEnvelope(envelope);
  if (!validation.valid) {
    throw new RunLedgerError(
      "build",
      `envelope validation failed: ${validation.errors.map((error) => `${error.field}: ${error.message}`).join("; ")}`,
    );
  }
  return envelope;
}

/**
 * Wrap `inner` in myelin's outbox at `spoolPath` and send one event through it.
 * The outbox spools before it sends and never rejects, so a send failure is
 * read off its log and thrown here. Failures while replaying an older spool are
 * not this emit's: those entries stay spooled for the next one.
 */
export async function publishThroughOutbox(
  event: ExecutionRunFinishedEvent,
  target: { inner: TransportPublisher; spoolPath: string },
): Promise<void> {
  const envelope = await buildRunFinishedEnvelope(event);
  const { createOutbox } = await import("@the-metafactory/myelin/outbox");

  const failures: string[] = [];
  let sending = false;
  const outbox = createOutbox({
    path: target.spoolPath,
    inner: target.inner,
    log: (message) => {
      if (sending) failures.push(message);
    },
  });
  await outbox.drained;
  sending = true;
  await outbox.publish(event.subject, envelope);
  if (failures.length > 0) throw new RunLedgerError("publish", failures.join("; "));
}

/**
 * The default publisher: one NATS connection per emit, outbox first. An
 * unauthenticated connection is allowed to loopback only, as in reflex's
 * `buildNatsTransport`.
 */
function natsPublisher(config: RunLedgerConfig, spoolPath: string): RunFinishedPublisher {
  return async (event) => {
    let host: string;
    try {
      host = new URL(config.natsUrl).hostname;
    } catch (error) {
      throw new RunLedgerError("config", `${RUN_LEDGER_ENV.natsUrl} is not a URL: ${config.natsUrl}`, { cause: error });
    }
    if (config.natsCreds === undefined && !LOOPBACK_HOSTS.has(host)) {
      throw new RunLedgerError(
        "config",
        `${RUN_LEDGER_ENV.natsCreds} is required for a non-loopback ${RUN_LEDGER_ENV.natsUrl} (got ${host})`,
      );
    }
    const credentials = config.natsCreds?.startsWith("~/") ? `${homedir()}${config.natsCreds.slice(1)}` : config.natsCreds;
    if (credentials !== undefined && !existsSync(credentials)) {
      throw new RunLedgerError("config", `${RUN_LEDGER_ENV.natsCreds} names a missing file: ${credentials}`);
    }

    const { NATSTransport } = await loadMyelin();
    // One shot, bounded: no reconnect loop and a connect timeout inside the
    // ceiling, so an unreachable bus cannot hold the process open after the
    // verb has returned.
    class OneShotNatsTransport extends NATSTransport {
      protected override buildConnectionOptions(common: { servers: string | string[]; name?: string; reconnect?: boolean; maxReconnectAttempts?: number }) {
        return { ...super.buildConnectionOptions(common), reconnect: false, timeout: RUN_LEDGER_TIMEOUT_MS };
      }
    }
    const nats = new OneShotNatsTransport({
      servers: config.natsUrl,
      name: `soma-${config.principal}`,
      ...(credentials === undefined ? {} : { credentials, requireAuth: true }),
      reconnect: false,
    });
    try {
      await publishThroughOutbox(event, { inner: nats, spoolPath });
    } finally {
      await nats.close().catch(() => undefined);
    }
  };
}

async function emit(input: RunFinishedInput, config: RunLedgerConfig, publish: RunFinishedPublisher): Promise<void> {
  const { createExecutionRunFinished } = await loadMyelin();
  const serves = input.serves ?? config.serves;
  let event: ExecutionRunFinishedEvent;
  try {
    event = createExecutionRunFinished({
      source: `${config.principal}.soma.run`,
      principal: config.principal,
      stack: config.stack,
      sovereignty: RUN_LEDGER_SOVEREIGNTY,
      payload: {
        run_id: input.runId,
        producer: "soma",
        ran: { kind: input.kind, ref: input.ref },
        outcome: input.outcome,
        started_at: input.startedAt,
        ended_at: input.endedAt,
        ...(serves === undefined ? {} : { serves }),
        ...(config.correlationId === undefined ? {} : { correlation_id: config.correlationId }),
        ...(input.detailRef === undefined ? {} : { detail_ref: input.detailRef }),
      },
    });
  } catch (error) {
    throw new RunLedgerError("build", errorMessage(error), { cause: error });
  }
  await publish(event);
}

async function recordFailure(options: PublishRunFinishedOptions, input: RunFinishedInput, error: unknown): Promise<void> {
  const stage: RunLedgerStage = error instanceof RunLedgerError ? error.stage : "publish";
  const message = errorMessage(error);
  try {
    await appendSomaMemoryEvent(options.somaHome, {
      substrate: options.substrate,
      kind: "run_ledger.publish_failed",
      summary: `Run ledger did not publish ${input.kind} run ${input.runId} (${stage}): ${message}`,
      metadata: { runId: input.runId, kind: input.kind, outcome: input.outcome, stage, error: message },
    });
  } catch {
    // Telemetry is best-effort, like the delivery it reports on.
  }
}

/**
 * Publish one `execution.run.finished` for a run that just finished. Never
 * throws and never takes longer than `RUN_LEDGER_TIMEOUT_MS` plus the failure
 * event's append.
 */
export async function publishRunFinished(input: RunFinishedInput, options: PublishRunFinishedOptions): Promise<RunFinishedResult> {
  const config = readRunLedgerConfig(options.env ?? process.env);
  if (config === undefined) return "disabled";

  const publish = options.publish ?? natsPublisher(config, runLedgerSpoolPath(options.somaHome));
  const pending = emit(input, config, publish);
  // Past the ceiling the emit is abandoned, not cancelled: a late rejection is
  // already reported as the timeout.
  pending.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new RunLedgerError("timeout", `emit timed out after ${RUN_LEDGER_TIMEOUT_MS} ms`));
    }, RUN_LEDGER_TIMEOUT_MS);
  });
  try {
    await Promise.race([pending, ceiling]);
    return "published";
  } catch (error) {
    await recordFailure(options, input, error);
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}
