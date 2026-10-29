import { defaultSomaHome } from "../core/index";
import { dropErrata, readErrata, readErrataLanded, runErrataTriage, type ErrataLandedResult, type ErrataTriageDeps } from "../flows/index";
import { readOption } from "./parse-utils";

export interface ParsedErrataArgs {
  command: "errata";
  action: "list" | "drop" | "triage" | "landed";
  id?: string;
  options: { somaHome?: string; homeDir?: string; session?: string; all?: boolean; json?: boolean };
}

export const ERRATA_COMMAND_HELP = {
  usage: "Usage: soma errata <list|drop|triage|landed> [--soma-home <path>]",
  subcommands: {
    list: "Usage: soma errata list [--session <id>] [--all] [--json] [--soma-home <path>] [--home-dir <path>]",
    drop: "Usage: soma errata drop E<n> [--soma-home <path>] [--home-dir <path>]",
    triage: "Usage: soma errata triage [--soma-home <path>] [--home-dir <path>]",
    landed: "Usage: soma errata landed <proposal-ref>|--all [--json] [--soma-home <path>] [--home-dir <path>]",
  },
};

export function parseErrataArgs(args: string[]): ParsedErrataArgs {
  const [command, action, ...rest] = args;
  if (command !== "errata" || (action !== "list" && action !== "drop" && action !== "triage" && action !== "landed")) throw new Error(ERRATA_COMMAND_HELP.usage);
  const options: ParsedErrataArgs["options"] = {};
  let id: string | undefined;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--soma-home" || arg === "--home-dir") {
      options[arg === "--soma-home" ? "somaHome" : "homeDir"] = readOption(rest, index, arg);
      index++;
    } else if (action === "list" && arg === "--session") {
      options.session = readOption(rest, index, arg);
      index++;
    } else if ((action === "list" || action === "landed") && arg === "--all") options.all = true;
    else if ((action === "list" || action === "landed") && arg === "--json") options.json = true;
    else if (action === "drop" && id === undefined && /^E[1-9]\d*$/.test(arg)) id = arg;
    else if (action === "landed" && id === undefined && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(arg)) id = arg;
    else throw new Error(`Unexpected Errata argument: ${arg}.\n${ERRATA_COMMAND_HELP.subcommands[action]}`);
  }
  if (action === "drop" && id === undefined) throw new Error(ERRATA_COMMAND_HELP.subcommands.drop);
  if (action === "landed" && ((id === undefined && !options.all) || (id !== undefined && options.all))) throw new Error(ERRATA_COMMAND_HELP.subcommands.landed);
  return { command, action, id, options };
}

function formatLandedWindow(value: ErrataLandedResult["before"]): string {
  return value === null ? "unavailable" :
    `[${value.start}, ${value.end}) errata=${value.errata} candidates=${value.candidates} rate=${value.rate ?? "n/a"}`;
}

function formatLandedRow(row: ErrataLandedResult): string {
  return `${row.ref}\t${row.verdict}\tclusterId=${row.clusterId} key=${JSON.stringify(row.key)}\tlandedAt=${row.landedAt ?? "unavailable"}\twindowDays=${row.windowDays}`
    + `\tbefore=${formatLandedWindow(row.before)}\tafter=${formatLandedWindow(row.after)}\treason=${row.reason ?? "none"}`;
}

export async function runErrataCli(parsed: ParsedErrataArgs, deps: Omit<ErrataTriageDeps, "somaHome"> = {}): Promise<string> {
  const somaHome = defaultSomaHome(parsed.options);
  if (parsed.action === "landed") {
    const rows = await readErrataLanded(somaHome, { ref: parsed.id });
    if (parsed.options.json) return JSON.stringify(parsed.options.all ? rows : rows[0], null, 2);
    if (rows.length === 0) return "No Errata proposals.";
    return rows.map(formatLandedRow).join("\n");
  }
  if (parsed.action === "triage") {
    const result = await runErrataTriage({ ...deps, somaHome });
    const counts = `${result.promoted} promoted, ${result.dropped} dropped, ${result.skipped} skipped, ${result.unlinkable} unlinkable, `
      + `${result.clustered} clustered, ${result.ripe} ripe, ${result.proposed} proposed, ${result.unroutable} unroutable`;
    if (result.outcome === "failed") throw new Error(`Errata triage failed: ${counts}. Unjudged candidates and unclustered Errata will be retried.`);
    return `Errata triage: ${counts}.`;
  }
  if (parsed.action === "drop") {
    if (parsed.id === undefined) throw new Error(ERRATA_COMMAND_HELP.subcommands.drop);
    await dropErrata(somaHome, parsed.id);
    return `Dropped ${parsed.id}.`;
  }
  const records = (await readErrata(somaHome, parsed.options))
    .filter((record) => parsed.options.session === undefined || record.sessionId === parsed.options.session);
  if (parsed.options.json) return JSON.stringify(records, null, 2);
  if (records.length === 0) return "No Errata.";
  // The complaint stays home; the list identifies the rejection without printing it.
  return records.map((record) => `${record.id}\t${record.status}\t${record.sessionId}\t${record.rejectedTurnUuid}\t${record.artifacts.join(", ")}`).join("\n");
}
