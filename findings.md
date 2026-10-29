# Hollow-pass regression, 2026-10: diagnosis

Node #1115, map the-metafactory/soma "Soma learns from LifeOS 8.761.0". Written 2026-10-28.

The node asks for `docs/research/hollow-pass-regression-2026-10.md`. The research SOP only allows a diff that touches `findings.md`, so this file is that document. The follow-up node can move it there.

## Answer

The rise is a measurement artifact of a caller defect that has already been fixed, kept red by the 60-day window. It is not a rising hollow-pass rate today.

- **Cause (F1).** From 2026-05-14 (`137bb70`) to 2026-09-27, `soma algorithm batch --op verify:C1:passed:<evidence>` had no syntax for an evidence kind. The batch path filled in `defaultEvidenceKind(undefined, "passed") = "specified"`, and the VerificationGate (from 2026-07-07, `1735711`) refuses every `passed` with kind `specified`. Every batch `passed` was refused, whatever its evidence. `d4bd1ad` (#719, 2026-09-27 20:08 +0200) added `passed+probed|+tested` to the batch syntax.
- **Timing (F2).** 1,199 of the 1,204 refusals since 2026-05-01 happened before #719 merged. Since then there have been 5. The weekly rate has been 0.71% or lower ever since, against a baseline of 0.23%.
- **Window lag (F3).** The gate reads a trailing 60-day window, so the burst between 2026-08-24 and 2026-09-27 stays in it until late November. With no new refusals, the gate goes green (below 5.23%, the baseline plus tolerance) at the 2026-11-16 run.
- **Recommendation.** Fix the metric. Do not re-baseline, and do not change callers again. Details are in the Recommendation section.

## How the metric is computed

- `scripts/harness-eval.ts:372-394`: numerator = `verification.gate_violation` events in the window; denominator = numerator + passed verifications (`countPassedVerifications`, `scripts/harness-eval.ts:308`).
- Gate rule: `src/vsa/vsa-accessors.ts:207-227` (`verificationGateViolation`). A `passed` whose `defaultEvidenceKind` is `specified` returns `specification_only`.
- Emitter: `src/cli/algorithm.ts:895-922` (`appendVerificationGateViolationEvent`). It records `reason`, `evidenceKind`, `runId`, `criterionId`, `substrate` and `sessionId`. It does not record the evidence text or which CLI action (`verify` or `batch`) produced it.
- Baseline: `scripts/harness-eval-baseline.json` gives 0.23% on a denominator of 862, captured 2026-07-11, `windowDays: 60`.

## Reproduction scripts

The scripts live outside the repo so that the push diff is `findings.md` only. Recreate them from the listings in the appendix, then run from the repo root:

- `bun /tmp/hp1115/decompose.ts $PWD` writes the weekly table, the reason, kind and substrate splits, the top runs, and `/tmp/hp1115/violations.json`.
- `bun /tmp/hp1115/retry.ts $PWD` gives the retry-to-pass counts, caller families and the post-#719 refusals.
- `bun /tmp/hp1115/project.ts $PWD` gives the quality of retry evidence and replays the 60-day gate with harness-eval's own `computeMetrics` at past and future dates.

They read `~/.soma/memory/STATE/events.jsonl` through `streamEventLines` (which includes the rotated segments) and the run files through `loadRuns`, using the same regexes as `scripts/harness-eval.ts:239,247`.

**Method check.** `project.ts`, replayed at 2026-10-26T08:04:07Z, gives `17.46% — 986 gate refusals vs 4661 passed verifications`. That matches `~/Library/Logs/soma/harness-gate.log` line 430 exactly.

## Numerator and denominator per week

Weeks start on Monday, in UTC. Source: `bun /tmp/hp1115/decompose.ts $PWD`. Rate = refusals / (refusals + passed). Weeks 2026-07-13 and 2026-07-20 have no refusals and no passed verifications in the run corpus; whether that was inactivity or missing data is unmeasured.

| Week | Refusals | Passed | Weekly rate |
| --- | ---: | ---: | ---: |
| 2026-07-06 (baseline week) | 2 | 136 | 1.45% |
| 2026-07-27 | 8 | 32 | 20.00% |
| 2026-08-03 | 28 | 132 | 17.50% |
| 2026-08-10 | 70 | 257 | 21.41% |
| 2026-08-17 | 35 | 166 | 17.41% |
| 2026-08-24 | 257 | 365 | 41.32% |
| 2026-08-31 | 370 | 757 | 32.83% |
| 2026-09-07 | 154 | 320 | 32.49% |
| 2026-09-14 | 188 | 481 | 28.10% |
| 2026-09-21 | 87 | 300 | 22.48% |
| 2026-09-28 (#719 merged 09-27) | 2 | 280 | 0.71% |
| 2026-10-05 | 1 | 928 | 0.11% |
| 2026-10-12 | 2 | 897 | 0.22% |
| 2026-10-19 | 0 | 479 | 0.00% |
| 2026-10-26 (to 2026-10-28) | 0 | 168 | 0.00% |

**Live probe, 2026-10-28.** The current week matches the last row. `bun run harness-eval --window 7` gives `0% — 0 gate refusals vs 519 passed verifications` (window from 2026-10-21T13:19Z, so it spans parts of two table rows). `bun run harness-eval` (60 days) gives `14.82% — 812 gate refusals vs 4668 passed verifications`.

### What the weekly gate reported (60-day window)

Source: `grep -n "Hollow-pass attempt rate" -A1 ~/Library/Logs/soma/harness-gate.log`.

| Gate run | 60-day reading |
| --- | --- |
| 2026-07-11 (baseline) | 0.23%: 2 / 859 |
| 2026-07-30 to 2026-09-14 | no reading: `error: Script not found "harness-eval"` (log lines 143-164) |
| 2026-09-16 (4 runs) | 28.32% to 28.35%: 886 to 900 refusals |
| 2026-09-21 | 27.79%: 966 / 3476 |
| 2026-09-28 | 0.39%: 11 / 2821. Not trustworthy: the run read only `674 events in window`, against 52,327 on 09-16 and 121,076 on 10-26 (log lines 302-305). The loader missed rotated segments that day. The cause is unmeasured; this is a separate defect (F6). |
| 2026-10-05 | 27.93%: 1175 / 4207 |
| 2026-10-12 | 23.18%: 1148 / 4953 |
| 2026-10-19 | 19.56%: 1074 / 5490 |
| 2026-10-26 | 17.46%: 986 / 5647 |

The gate was blind from 2026-07-30 to 2026-09-14, so the rise was first seen on 2026-09-16, already near its peak. The 60-day reading has been falling since 2026-10-05 because the burst is ageing out.

## Attribution

Each finding gives the command that produces its numbers.

### F1: refusal reason and evidence kind point to the batch path

Source: `bun /tmp/hp1115/decompose.ts $PWD`, sections `reason` and `evidenceKind`.

- `specification_only` accounts for 1,203 refusals and `rote_evidence` for 1. None was a rote "done".
- The recorded `evidenceKind` is `specified` on all 1,204, and on none is it `null`. That matters for attribution:
  - The single `verify` CLI passes the user's `--evidence-kind` through unchanged (`git show d4bd1ad^:src/cli/algorithm.ts`, line 1164). A bare `verify --status passed` would record `null`.
  - The pre-#719 batch path passed `defaultEvidenceKind(...)`, which turns undefined into `"specified"` (`git show d4bd1ad^:src/algorithm.ts | sed -n 930,940p`; `git grep -n "function defaultEvidenceKind" -A6 d4bd1ad^ -- src`).
  - So no refusal came from a bare single `verify`. Each one came from the batch path or from an explicit `specified` kind.
- **Unmeasured:** the split between `--op`, `--ops-json` and an explicit `--evidence-kind specified`. The event does not record the CLI action.

### F2: one fix explains the turn

Source: `bun /tmp/hp1115/retry.ts $PWD`, line `after #719 merge`, and `git show --stat d4bd1ad`.

- 1,199 of 1,204 refusals predate `d4bd1ad`. The 5 after it are on 2026-09-28, 09-30, 10-11, 10-15 and 10-16, all `specification_only` and `specified`. Their callers are `sage-724-codequality`, `seelite-issue-64-decision`, one pi-dev ranger run, `soma-test-slowness-20261015` and `field-notes-weekly-2026-10-16`.
- **Unmeasured:** why the burst started in late July when batch had existed since 2026-05-14 and the gate since 2026-07-07. It coincides with heavy use of batch-verify by review runs (F4). That is inferred from timing, not measured.

### F3: the refusals were retries, not hollow passes that landed

Source: `bun /tmp/hp1115/retry.ts $PWD`.

- The 1,204 refusals fall on 1,057 distinct run/criterion pairs.
- 994 of those pairs recorded a `passed` after their last refusal: a median of 0.3 minutes later, and 0.5 minutes at the 90th percentile.
- 63 never recorded a pass.
- The rate's numerator therefore counts almost entirely attempts the gate turned back, which a caller re-recorded seconds later.

### F4: the callers

Source: `bun /tmp/hp1115/retry.ts $PWD` for families and substrates; `bun /tmp/hp1115/decompose.ts $PWD` for top runs and days.

By substrate:

| Substrate | Refusals | Note |
| --- | ---: | --- |
| `custom` | 1,067 | 1,064 of these are on runs with no `substrate` field; 3 are on codex runs whose verify call omitted `--substrate` |
| `codex` | 97 | |
| `claude-code` | 28 | |
| `dsh` | 10 | |
| `pi-dev` | 2 | |

By run-id family (a naming heuristic, not caller identity):

| Family | Refusals |
| --- | ---: |
| review runs (`sage-*`, `review-pr-*`) | 737 (698 `custom`, 39 `codex`) |
| other named runs | 317 |
| dated-slug runs (ranger and orienteer style) | 150 |

Concentration:

- **Busiest days:** 2026-08-27 had 180 refusals, 2026-09-02 had 122 and 2026-09-15 had 102.
- **Top runs:** a family of Sage review runs on PR 218 (`sage-pr-218-*-2026-08-27`, 7 to 15 refusals each) and one enzian run on 2026-09-25 with 17.
- **Unmeasured:** which program made each call. `sessionId` is absent on 1,202 of 1,204 events. Session recording landed on 2026-10-14 (`915d840`), after the burst.

### F5: the residual real signal sits in the evidence, not the gate

Source: `bun /tmp/hp1115/project.ts $PWD`, first line.

- Of the 995 passes recorded after a refusal, 285 (28.64%) are probe-backed by `isProbeBacked`.
- The window-wide probe-backed rate is 40.79% (gate log line 428).
- So after the gate refused, callers often re-labelled the same assertion as `probed` or `tested` rather than adding a probe. That is a real quality problem, but `probe_evidence_rate` measures it, not this metric.
- **Unmeasured:** whether the refused evidence itself was probe-backed. The event does not store the evidence text.

### F6: separate measurement defects

- **2026-07-30 to 2026-09-14:** seven gate runs failed with `Script not found "harness-eval"` (`sed -n 143,164p ~/Library/Logs/soma/harness-gate.log`), so the regression went unseen for seven weeks.
- **2026-09-28:** the run read 674 events in its window and reported 0.39%, a false green (`sed -n 302,312p ~/Library/Logs/soma/harness-gate.log`). The cause is unmeasured.

## Projection

Assuming no new refusals, these are replays with `computeMetrics` at future dates (`bun /tmp/hp1115/project.ts $PWD`):

| Gate run | 60-day rate | Detail |
| --- | ---: | --- |
| 2026-11-02 | 12.68% | 613 / 4834 |
| 2026-11-09 | 7.37% | 285 / 3865 |
| 2026-11-16 | 4.49% | 153 / 3408 (passes the 5.23% threshold) |
| 2026-11-23 | 2.57% | 79 / 3076 |
| 2026-11-30 | 0.11% | 3 / 2693 |

## Recommendation: fix the metric

- **Do not re-baseline.** The baseline of 0.23% still describes current behaviour: weekly rates since #719 are 0.71%, 0.11%, 0.22%, 0.00% and 0.00%. Raising the baseline to fit the old window would hide a future regression of the same size.
- **Do not change callers again.** #719 already removed the cause (F2). The 5 refusals since then look like ordinary gate use.
- **Fix the metric.** It reported a CLI syntax gap as "hollow-pass attempts" and then held a fixed defect red for roughly 7 weeks after the fix (F3, projection). Two changes, sized for the follow-up node:
  1. Gate this metric on a 7-day or 14-day window, with the 60-day figure kept as context. A rare, high-signal event (`docs/harness-objective-function.md:95`) should turn the gate green within a week of a fix, not two months.
  2. Count distinct run/criterion pairs that were refused, rather than raw events. Report separately the pairs that never reached a probe-backed pass. That count is the hollow pass the metric's name promises: 63 pairs never passed (F3), and most retries were not probe-backed (F5).
- **Fix the measurement defects in F6 alongside, as their own nodes.** A gate that cannot run, or that reads 674 events, must fail loudly rather than report green. This is the map's "loops that bite" destination.

## Appendix: scripts

### /tmp/hp1115/decompose.ts

```ts
// Usage: bun /tmp/hp1115/decompose.ts <worktree>
const wt = process.argv[2];
const { streamEventLines } = await import(`${wt}/src/events/index`);
const { loadRuns } = await import(`${wt}/scripts/harness-eval.ts`);
const home = `${process.env.HOME}/.soma`;
const PASSED = /^([A-Za-z]+\d*)\s*:\s*passed\.?\s*(.*)$/s;
const SYNC = /synced from ISA:/i;
const since = Date.parse("2026-05-01T00:00:00Z");
const wk = (iso: string) => { const d = new Date(iso); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10); };
const viol: any[] = [];
for await (const line of streamEventLines(`${home}/memory/STATE/events.jsonl`)) {
  if (!line.includes("gate_violation")) continue;
  try { const e = JSON.parse(line); if (e.kind === "verification.gate_violation" && Date.parse(e.timestamp) >= since) viol.push(e); } catch {}
}
const runs = loadRuns(`${home}/memory/WORK/algorithm-runs`);
const passed: Record<string, number> = {};
for (const r of runs) for (const v of r.verification ?? []) {
  const m = PASSED.exec(v.text ?? ""); if (!m || SYNC.test(m[2]) || !v.timestamp) continue;
  if (Date.parse(v.timestamp) < since) continue; passed[wk(v.timestamp)] = (passed[wk(v.timestamp)] ?? 0) + 1;
}
const by = (f: (e: any) => string, list = viol) => { const o: Record<string, number> = {}; for (const e of list) { const k = f(e); o[k] = (o[k] ?? 0) + 1; } return Object.entries(o).sort((a, b) => b[1] - a[1]); };
const vw: Record<string, number> = Object.fromEntries(by((e) => wk(e.timestamp)));
console.log("## per ISO week (Mon, UTC): refusals | passed | rate");
for (const w of [...new Set([...Object.keys(vw), ...Object.keys(passed)])].sort()) {
  const n = vw[w] ?? 0, p = passed[w] ?? 0; console.log(w, n, p, n + p ? ((100 * n) / (n + p)).toFixed(2) + "%" : "n/a");
}
console.log("\n## total refusals since", new Date(since).toISOString(), viol.length);
console.log("\n## reason"); console.log(by((e) => e.metadata?.reason));
console.log("\n## evidenceKind"); console.log(by((e) => String(e.metadata?.evidenceKind)));
console.log("\n## substrate"); console.log(by((e) => e.substrate));
console.log("\n## distinct runs", new Set(viol.map((e) => e.metadata?.runId)).size, " distinct sessions", new Set(viol.map((e) => e.metadata?.sessionId)).size);
console.log("\n## top runs"); console.log(by((e) => e.metadata?.runId).slice(0, 15));
console.log("\n## top run+criterion"); console.log(by((e) => e.metadata?.runId + "/" + e.metadata?.criterionId).slice(0, 10));
console.log("\n## top day"); console.log(by((e) => e.timestamp.slice(0, 10)).slice(0, 15));
console.log("\n## top sessions"); console.log(by((e) => String(e.metadata?.sessionId)).slice(0, 10));
await Bun.write("/tmp/hp1115/violations.json", JSON.stringify(viol));
```

### /tmp/hp1115/retry.ts

```ts
const wt = process.argv[2];
const { loadRuns } = await import(`${wt}/scripts/harness-eval.ts`);
const viol: any[] = JSON.parse(await Bun.file("/tmp/hp1115/violations.json").text());
const runs = loadRuns(`${process.env.HOME}/.soma/memory/WORK/algorithm-runs`);
const byId = new Map(runs.map((r: any) => [r.id, r]));
const PASSED = /^([A-Za-z]+\d*)\s*:\s*passed\.?\s*(.*)$/s;
const pairs = new Map<string, any[]>();
for (const e of viol) { const k = `${e.metadata.runId}\u0000${e.metadata.criterionId}`; (pairs.get(k) ?? pairs.set(k, []).get(k)!).push(e); }
let later = 0, missingRun = 0, never = 0; const lagMin: number[] = [];
for (const [k, list] of pairs) {
  const [rid, cid] = k.split("\u0000"); const r: any = byId.get(rid);
  if (!r) { missingRun++; continue; }
  const last = Math.max(...list.map((e) => Date.parse(e.timestamp)));
  const p = (r.verification ?? []).find((v: any) => { const m = PASSED.exec(v.text ?? ""); return m && m[1] === cid && Date.parse(v.timestamp) >= last; });
  if (p) { later++; lagMin.push((Date.parse(p.timestamp) - last) / 60000); } else never++;
}
lagMin.sort((a, b) => a - b);
console.log({ refusals: viol.length, pairs: pairs.size, passedAfterRefusal: later, neverPassed: never, runFileMissing: missingRun, medianLagMin: lagMin[Math.floor(lagMin.length / 2)]?.toFixed(1), p90LagMin: lagMin[Math.floor(lagMin.length * 0.9)]?.toFixed(1) });
const fam = (id: string) => /^sage-|^review-pr|-review-/.test(id) ? "review (sage-*/review-pr-*)" : /^\d{4}-\d{2}-\d{2}-/.test(id) ? "dated-slug (ranger/orienteer-style)" : "other named";
const o: Record<string, number> = {}; for (const e of viol) { const f = fam(e.metadata.runId) + " / " + e.substrate; o[f] = (o[f] ?? 0) + 1; }
console.log(Object.entries(o).sort((a, b) => b[1] - a[1]));
const sub: Record<string, number> = {}; for (const e of viol) { const r: any = byId.get(e.metadata.runId); const s = `event=${e.substrate} run=${r?.substrate ?? "none"}`; sub[s] = (sub[s] ?? 0) + 1; }
console.log(Object.entries(sub).sort((a, b) => b[1] - a[1]));
const after = viol.filter((e) => Date.parse(e.timestamp) >= Date.parse("2026-09-27T18:08:28Z"));
console.log("after #719 merge:", after.length, after.map((e) => [e.timestamp, e.substrate, e.metadata.reason, e.metadata.evidenceKind, e.metadata.runId]));
```

### /tmp/hp1115/project.ts

```ts
// Retry evidence quality + projected 60d window rate using harness-eval's own computeMetrics.
const wt = process.argv[2];
const H = await import(`${wt}/scripts/harness-eval.ts`);
const home = `${process.env.HOME}/.soma`;
const viol: any[] = JSON.parse(await Bun.file("/tmp/hp1115/violations.json").text());
const runs = H.loadRuns(`${home}/memory/WORK/algorithm-runs`);
const byId = new Map(runs.map((r: any) => [r.id, r]));
const PASSED = /^([A-Za-z]+\d*)\s*:\s*passed\.?\s*(.*)$/s;
let pb = 0, n = 0; const seen = new Set<string>();
for (const e of viol) {
  const k = e.metadata.runId + "/" + e.metadata.criterionId; if (seen.has(k)) continue; seen.add(k);
  const r: any = byId.get(e.metadata.runId); const crit = H.runCriteria(r);
  const p = (r.verification ?? []).find((v: any) => { const m = PASSED.exec(v.text ?? ""); return m && m[1] === e.metadata.criterionId && Date.parse(v.timestamp) >= Date.parse(e.timestamp); });
  if (!p) continue; n++; if (H.isProbeBacked(PASSED.exec(p.text)![2], crit.get(e.metadata.criterionId))) pb++;
}
console.log(`retry passes after a refusal: ${n}; probe-backed by isProbeBacked: ${pb} (${(100 * pb / n).toFixed(2)}%)`);
const events = await H.loadEvents(`${home}/memory/STATE/events.jsonl`, Date.parse("2026-06-01T00:00:00Z"));
for (const d of ["2026-10-26T08:04:07Z", "2026-10-28T12:00:00Z", "2026-11-02T08:00:00Z", "2026-11-09T08:00:00Z", "2026-11-16T08:00:00Z", "2026-11-23T08:00:00Z", "2026-11-30T08:00:00Z"]) {
  const m = H.computeMetrics({ runs, events, now: new Date(d), windowDays: 60 }).find((x: any) => x.id === "hollow_pass_attempt_rate");
  console.log(d, m.value?.toFixed(2) + "%", m.detail);
}
```
