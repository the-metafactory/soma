#!/usr/bin/env bun
// Codex lifecycle hook entry (soma#73). Replaces the previous
// `renderCodexLifecycleHook` code-gen pattern.
//
// Runtime contract:
//   - shebang `bun` — every soma substrate hook runs under Bun
//   - colocated `soma-lifecycle.config.json` holds the install-time
//     config (somaHome, trustedSomaRepo, privateRoots, policyMarkers)
//   - this file is shipped verbatim by `projectCodexHome`; no
//     install-time string templating
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runCodexHook } from "./codex-hook-entry.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, "soma-lifecycle.config.json"), "utf8"));
runCodexHook(config);
