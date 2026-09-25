/** Arc's small bootstrap entrypoint. Graph operations execute from the frozen CLI. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { inspectRuntimeArtifact, locateRuntimeArtifact } from "./runtime-artifact";

const args = process.argv.slice(2);
const maintenance = new Set(["init", "install", "reproject", "upgrade", "runtime", "uninstall"]);
const sourceEntry = join(import.meta.dir, "cli.ts");
const homeFlag = args.indexOf("--soma-home");
const somaHome = resolve(homeFlag >= 0 && args[homeFlag + 1] ? args[homeFlag + 1] : process.env.SOMA_HOME ?? join(homedir(), ".soma"));
let entry = sourceEntry;
if (maintenance.has(args[0] ?? "")) entry = sourceEntry;
else {
  // Even read-only graph verbs load the same mutable-on-disk module. Verify all
  // graph launches: a modified "node" handler could write despite its verb.
  // The measured warm hash cost is ~10 ms for the current source tree.
  const graphCommand = args[0] === "graph";
  const runtime = graphCommand
    ? await inspectRuntimeArtifact(somaHome, "cli", { load: false })
    : await locateRuntimeArtifact(somaHome, "cli");
  if (runtime.status === "ready" && runtime.state) {
    // Pin the selected hash; a concurrent activation cannot redirect this invocation.
    entry = join(somaHome, "runtime", "artifacts", runtime.state.active, "src", "cli.ts");
  } else {
    if (args.length === 0 || args[0] === "--help" || args[0] === "--version") entry = sourceEntry;
    else {
      process.stderr.write(`Soma CLI runtime is ${runtime.status}. Run \`soma install <substrate> --apply\` or \`soma runtime rollback --target cli\` to recover.\n`);
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
