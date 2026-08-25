import { expect, test } from "bun:test";
import { installSpecFor } from "../src/install-spec-registry";
import { somaMemoryPrivateRoots, somaProjectionPrivateRoots } from "../src/projection-private-roots";
import { projectCodexHome } from "../src/adapters/codex/adapter";
import { projectGrokHome } from "../src/adapters/grok/adapter";
import { portableProjectionInput } from "./fixtures";

const homeDir = "/tmp/soma-private-root-drift";
const somaHome = "/tmp/soma-private-root-drift/.soma";

function configuredRoots(substrate: "claude-code" | "codex" | "grok"): string[] {
  if (substrate === "codex") {
    const file = projectCodexHome(portableProjectionInput, somaHome, homeDir, "/runtime/current").files.find((entry) => entry.path === "hooks/soma-lifecycle.config.json");
    return JSON.parse(file!.content).privateRoots;
  }
  if (substrate === "grok") {
    const file = projectGrokHome(portableProjectionInput, somaHome, { homeDir, somaRepoPath: "/runtime/current" }).files.find((entry) => entry.path === "hooks/soma-lifecycle.config.json");
    return JSON.parse(file!.content).privateRoots;
  }
  // Claude Code declares no adapter-private roots; its policy hook receives the
  // shared policy evaluator, so an empty config is the expected agreement.
  return [];
}

test("guarded substrate private roots agree across install specs, hook configs, and policy", () => {
  for (const substrate of ["claude-code", "codex", "grok"] as const) {
    const spec = installSpecFor(substrate).privateRoots;
    const expected = [
      ...(spec?.projection?.({ homeDir, substrate }) ?? []),
      ...(spec?.memory?.({ homeDir, substrate }) ?? []),
    ].map((path) => path.replace(/\\/g, "/"));
    const policy = [
      ...somaProjectionPrivateRoots({ homeDir, substrate }),
      ...somaMemoryPrivateRoots({ homeDir, substrate }),
    ].map((path) => path.replace(/\\/g, "/"));
    const config = configuredRoots(substrate).map((path) => path.replace(/\\/g, "/"));
    expect(policy).toEqual(expected);
    expect(config).toEqual(expected);
  }
});
