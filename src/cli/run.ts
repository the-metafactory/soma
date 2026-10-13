/**
 * `soma run finished` (node #821): the general verb a scheduled job calls to
 * report one finished run on the run ledger. It parses flags and hands them to
 * the funnel in `src/run-ledger.ts`, which owns the bus environment.
 *
 * A reporting failure never fails the job that called it: a bad flag publishes
 * nothing, writes one stderr line naming the flag, and still returns, so the
 * process exits 0. Only an unknown subcommand is a usage error.
 */
import { randomUUID } from "node:crypto";
import { defaultSomaHome } from "../paths";
import {
  publishRunFinished,
  RUN_KINDS,
  RUN_OUTCOMES,
  type ExecutionRunState,
  type RunFinishedInput,
  type RunFinishedResult,
  type RunKind,
  type RunLedgerDeps,
  type RunOutcome,
} from "../run-ledger";

export const RUN_COMMAND_HELP = {
  usage: "Usage: soma run finished --kind <kind> --ref <ref> --outcome <outcome> --started-at <iso> [--detail-ref <path>] [--state-subject <s> --state-value <v>]",
  subcommands: {
    finished:
      "Usage: soma run finished --kind <flow|node|algorithm|dispatch|job> --ref <ref> --outcome <succeeded|failed|cancelled|blocked> --started-at <iso> [--detail-ref <path>] [--state-subject <s> --state-value <v>] (SOMA_PRINCIPAL unset: nothing is published)",
  },
};

/** The ledger deps `AlgorithmCliDeps` takes, plus the verb's own clock, run id and stderr. */
export interface RunCliDeps extends RunLedgerDeps {
  somaHome?: string;
  now?: () => Date;
  runId?: () => string;
  stderr?: (line: string) => void;
}

const FLAGS = ["--kind", "--ref", "--outcome", "--started-at", "--detail-ref", "--state-subject", "--state-value"] as const;
type Flag = (typeof FLAGS)[number];

// The run ledger's timestamp shape: ISO 8601 extended, `Z` or a `±hh:mm` offset.
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

function isIsoTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP.exec(value);
  if (match === null || !Number.isFinite(Date.parse(value))) return false;
  // An unmatched group (the offset of a `Z` stamp) is undefined at runtime.
  const groups: (string | undefined)[] = match.slice(1);
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = groups.map((part) => Number(part ?? 0));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth
    && hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59;
}

class RunFlagError extends Error {}

function oneOf<T extends string>(flag: Flag, value: string, values: readonly T[]): T {
  if (!(values as readonly string[]).includes(value)) {
    throw new RunFlagError(`${flag} must be one of ${values.join(", ")} (got "${value}")`);
  }
  return value as T;
}

/** Everything but `runId` and `endedAt`, which belong to the call, not the flags. */
type RunFinishedFlags = Omit<RunFinishedInput, "runId" | "endedAt">;

function parseFinishedFlags(args: string[]): RunFinishedFlags {
  const values = new Map<Flag, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!(FLAGS as readonly string[]).includes(flag)) throw new RunFlagError(`unknown flag ${flag}`);
    const value = index + 1 < args.length ? args[index + 1] : "";
    if (value === "" || value.startsWith("--")) throw new RunFlagError(`${flag} requires a value`);
    values.set(flag as Flag, value);
  }
  const required = (flag: Flag): string => {
    const value = values.get(flag);
    if (value === undefined) throw new RunFlagError(`${flag} is required`);
    return value;
  };

  const kind = oneOf<RunKind>("--kind", required("--kind"), RUN_KINDS);
  const ref = required("--ref");
  const outcome = oneOf<RunOutcome>("--outcome", required("--outcome"), RUN_OUTCOMES);
  const startedAt = required("--started-at");
  if (!isIsoTimestamp(startedAt)) {
    throw new RunFlagError(`--started-at must be an ISO 8601 timestamp with Z or a ±hh:mm offset (got "${startedAt}")`);
  }
  const subject = values.get("--state-subject");
  const value = values.get("--state-value");
  if ((subject === undefined) !== (value === undefined)) {
    throw new RunFlagError(`--state-subject and --state-value go together; got only ${subject === undefined ? "--state-value" : "--state-subject"}`);
  }
  const state: ExecutionRunState | undefined = subject === undefined || value === undefined ? undefined : { subject, value };
  const detailRef = values.get("--detail-ref");
  return {
    kind,
    ref,
    outcome,
    startedAt,
    ...(detailRef === undefined ? {} : { detailRef }),
    ...(state === undefined ? {} : { state }),
  };
}

/** `args` is everything after `run`, e.g. `["finished", "--kind", "job", ...]`. */
export async function runRunCli(args: string[], deps: RunCliDeps = {}): Promise<string> {
  const [action, ...rest] = args;
  if (action !== "finished") throw new Error(RUN_COMMAND_HELP.usage);

  let flags: RunFinishedFlags;
  try {
    flags = parseFinishedFlags(rest);
  } catch (error) {
    if (!(error instanceof RunFlagError)) throw error;
    const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
    stderr(`soma run finished: ${error.message}; nothing published`);
    return "run finished: rejected";
  }

  // A job has no run record of its own, so each call is one run with a fresh id.
  const result: RunFinishedResult = await publishRunFinished(
    { ...flags, runId: deps.runId?.() ?? randomUUID(), endedAt: (deps.now?.() ?? new Date()).toISOString() },
    {
      somaHome: deps.somaHome ?? defaultSomaHome(),
      substrate: "custom",
      env: deps.env,
      publish: deps.publishRunFinished,
    },
  );
  return `run finished: ${result}`;
}
