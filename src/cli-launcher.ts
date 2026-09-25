/** Arc's small bootstrap entrypoint. Graph operations execute from the frozen CLI. */
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const maintenance = new Set(["init", "install", "reproject", "upgrade", "runtime", "uninstall"]);
const sourceEntry = join(import.meta.dir, "cli.ts");
const homeFlag = args.indexOf("--soma-home");
const somaHome = resolve(homeFlag >= 0 && args[homeFlag + 1] ? args[homeFlag + 1] : process.env.SOMA_HOME ?? join(homedir(), ".soma"));
const frozenEntry = join(somaHome, "runtime", "cli", "current", "src", "cli.ts");

let entry = frozenEntry;
if (maintenance.has(args[0] ?? "")) entry = sourceEntry;
else {
  try { await access(frozenEntry); }
  catch {
    if (args.length === 0 || args[0] === "--help" || args[0] === "--version") entry = sourceEntry;
    else {
      process.stderr.write("Soma CLI runtime is missing. Run `soma install <substrate> --apply` to stage it.\n");
      process.exit(1);
    }
  }
}

const child = Bun.spawn([process.execPath, entry, ...args], {
  cwd: process.cwd(),
  env: process.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
