# Findings: why `lifecycle session-start` cost ~6.3 s when `session-end` cost 327 ms

Node #613 · checkpoint `cp-session-start-outlier` · measured 2026-10-12 at `d1e84b8` (soma 0.26.0)

## Answer

**It was real work, not load, and it is already fixed.** The ~6.3 s from #605 was
`reprojectSubstrateMemoryProjection` reading the **entire skill corpus into memory**
on every session start. Session-end never loads skills, which explains the asymmetry.
Commit `fc0e9f9` fixed it (#712 for issue #711, 2026-09-25, shipped in **v0.20.3**). On
HEAD, session-start costs **0.35–0.43 s** wall on the CLI and 185–291 ms in-process.
No code change is needed for this node.

#605 suspected the right function but the wrong half of it. `reindexMemoryIfStale` (the
mtime-only, parse-free walk) is cheap as designed: 3 ms. The cost came after it. In
0.15.0, `src/memory-projection-reproject.ts:80` called `loadSomaHome(somaHome)` with
skills included, only to build a throwaway full projection bundle. It then wrote one
file from that bundle, the memory index. `loadSomaSkills` → `collectSkillFiles`
(0.15.0 `src/soma-home.ts:122-188`) recursed into every non-dot path under every
skill, `node_modules` included. It read every file serially as a UTF-8 string, so the
~60 MB compiled CLI binaries that several skills ship were read too.

The fix is one argument: `loadSomaHome(somaHome, { includeSkills: false })`, now at
`src/memory-projection-reproject.ts:83`.

## Measurements

Box: load average 20–77 throughout. The machine never got quiet; see the
**Limits** section. Every run pins **both** `--soma-home /tmp/n613/soma` and
`--home-dir /tmp/n613/home`. The scratch soma home is an rsync of the live soma home
(1532 Algorithm run JSONs, full skills tree including `node_modules`, `.git` excluded
because `collectSkillFiles` skips dot entries). Source trees for old versions came
from `git archive` (soma has no runtime dependencies).

### A/B across versions, full skills corpus (30,132 files / 1.35 G chars)

| tree | session-start wall (3 runs) | user+sys CPU | session-end wall |
| --- | --- | --- | --- |
| `0b3ee7a` (0.15.0, what #605 measured) | 27.17 / 20.93 / 20.60 s | ~11.5 s | 1.23 s |
| `fc0e9f9^` (just before the fix) | 18.79 / 18.55 / 18.52 s | ~11.3 s | 1.27 s |
| `fc0e9f9^` + **only** the `includeSkills: false` line | 0.76 / 0.75 / 0.83 s | — | — |
| `0b3ee7a` + **only** the `includeSkills: false` line | 0.92 / 0.82 / 0.69 s | — | — |
| `fc0e9f9` (the fix) | 1.16 / 0.78 / 0.80 s | ~1.2 s | 1.11 s |
| HEAD `d1e84b8` | 0.35–0.43 s (5 runs) | ~0.5 s | 0.96–1.09 s (5 runs) |

**Bisection.** The one-line patch alone removes the whole outlier on both pre-fix
trees: 18.5 s → 0.78 s. The other half of #712 (`listStartupAlgorithmRunSummaries`,
the cached startup run scan) changes nothing measurable on this home: 0.78 s vs 0.80 s.

**Mechanism, in isolation.** On 0.15.0, `loadSomaHome(home, { includeSkills: true })`
alone takes **18,324 ms** to load 30,132 files and 1,349 M chars, with RSS around 1 GB.
With `includeSkills: false` it takes **1 ms**.

### Reproducing #605's 6.3 s specifically

All three skill `node_modules` trees in the home were created *after* #605 measured on
2026-08-12:

| skill `node_modules` | created | files |
| --- | --- | --- |
| skill A | 2026-08-28 | 22,925 |
| skill B | 2026-09-01 | 1,297 |
| skill C | 2026-09-01 | 3,868 |

With those three moved aside, the scratch corpus matches August: 2,330 files and 516 M
chars, most of it compiled binaries. On that corpus, 0.15.0 costs:

- skill load alone: **6,845 ms**
- `session-start`: **4.71 / 4.12 / 4.06 s** wall, **~3.5 s user CPU**, at load ~21

That matches #605's 6.3 s at load 96–109. HEAD on the same corpus took 0.51 / 0.51 s.

### The load hypothesis is refuted

The competing hypothesis was that session-start's many small syscalls get punished by
scheduler contention. CPU time contradicts it. 0.15.0 session-start burns
**~3.5 s of user CPU** on the August-sized corpus and **~6.4 s user + ~5 s sys** on
today's. HEAD burns ~0.33 s user, and a no-skill 0.15.0 burns under 1 s. That is work
done, not time spent waiting on the run queue. Load inflated the wall clock
(27 s vs 18.5 s for the same code as load fell), but it did not create the gap.

## Why the cost grew silently, and the codex exposure it caused

The cost tracked the size of the skill corpus, so it got worse with no code change. It
went from ~4–7 s in August to **18–27 s** once the `node_modules` trees arrived
(2026-08-28 to 09-01). Codex runs session-start through `spawnSync` with a
**25,000 ms timeout** (`src/adapters/codex/hooks/codex-hook-entry.mjs:27-33`). One
0.15.0 run here took 27.17 s, so between those dates and v0.20.3, a codex session start
on a loaded box could hit the timeout. It would then fall back to the projected
startup context (`codex-hook-entry.mjs:411-424`), and the user waited ~25 s first.
Commit `287226d` (#720, 2026-09-28, `SKILL_SCAN_SKIP_DIRS` at `src/soma-home.ts:248`)
now also skips vendor dirs and binaries when scanning skills, which independently
shrinks a full skill load.

## What HEAD's session-start spends now

In-process step timings at HEAD (a scratch harness importing the exported step
functions, 2 runs). The steps do not add up exactly, because the total includes event
appends and VSA/session-name resolution.

| step | ms |
| --- | --- |
| module import (lifecycle + deps) | 29–33 |
| `buildSomaStartupContext` (incl. cached run summaries) | 10–11 |
| `upsertSomaCurrentWorkPointer` (registry lock + writes) | 76–187 |
| `reindexMemoryIfStale` | 3 |
| `reprojectSubstrateMemoryProjection` (whole thing) | 7–8 |
| `buildLearningReadback` | 82–84 |
| **`runSomaLifecycleSessionStart` total** | **185–291** |

Add the ~120 ms bun process floor and you get the observed 0.35–0.43 s CLI wall. The
work-registry upsert is the largest and most variable piece, probably lock and fs
contention. The learning readback is second. Neither is an outlier.

## New finding: session-end is now the expensive branch

The asymmetry has inverted. At HEAD, session-end costs **0.96–1.09 s** wall
(~1.0 s user CPU) against session-start's ~0.4 s. In-process:

| step | ms |
| --- | --- |
| `listAlgorithmRunSummaries` (full scan, 1532 run JSONs) | 423 |
| `writeAlgorithmWorkIndex` (wraps the scan) | 336 |
| `captureCompletedAlgorithmLearnings` (`listAlgorithmRuns`, full load) | 551 |

The full scan that #712 removed from session-start is still on session-end, twice over.
Like session-start, this scales with Algorithm history: it grows with every run,
forever. **Codex pays it synchronously**, because `codex-hook-entry.mjs:452` routes
`session-end` through the same `spawnSync` path. Claude-code runs it detached. This is
not a trivial fix (it needs an incremental index or a capture watermark, with #712's
`listStartupAlgorithmRunSummaries` as the precedent), so I am reporting it rather than
fixing it. It is a candidate for its own node.

## Residual risk

No test guards the fix. `test/memory-projection-reproject.test.ts:56` checks which
files reproject *writes*, not whether it *reads* skills, and
`test/lifecycle-startup-scaling.test.ts` never mentions skills. Dropping the
`includeSkills: false` would pass CI. With #720's skip-list, a regression would now
cost ~1.15 s for the skill load (measured at HEAD: 2,303 files / 14 M chars), not 18 s.
That is still a ~3× regression on codex's synchronous path. Encoding it as a test
(a skills fixture whose files throw on read, or a spy on `loadSomaSkills`, during
`reprojectSubstrateMemoryProjection`) would be cheap. That fits the soma#459 SelfHealing
doctrine, but it is a build task, not part of this research node.

## Limits

- **Not a quiet machine.** Load stayed between 20 and 77 for the whole session (load
  under 2 was never reached). I compared CPU time (user+sys) as well as wall time, and
  bisected with single-line patches on the same box minutes apart, so the attribution
  does not depend on load. The absolute wall numbers will be lower on a quiet box.
- The August home itself is gone. The "August-like" corpus is today's skills tree minus
  the three `node_modules` dirs born after 2026-08-12. It is a reconstruction, not the
  original. Other skills may have changed since then, and Algorithm history has grown.
- `bun --cpu-prof` produced a near-empty profile for HEAD (15 KB), because most of the
  path is async fs. The step harness replaced it.

## Isolation evidence

All runs wrote only under `/tmp/n613`. The projection landed at
`/tmp/n613/home/.claude/rules/soma/MEMORY.md`. The live claude-code `MEMORY.md`
projection's mtime is 2026-10-12 11:58, before this session started at 17:47. None of
the probe session ids (`probe-*`, `ab-*`, `bis-*`, `lean-*`, `fin-*`) appear in the
live home's `events.jsonl`. The two string matches there are unrelated subagent events
from 2026-10-04.
