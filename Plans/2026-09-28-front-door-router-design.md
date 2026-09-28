# Soma front-door router — design proposal

*2026-09-28 · status: proposal, nothing implemented · source: [How Jev Picks the Model and Effort for Every Prompt](https://danielmiessler.com/blog/glance-routes-model-and-effort) (LifeOS, 2026-09-24)*

*Rev 2 (2026-09-28): the primary question backend is now **Laya**, an open-weights model that runs locally. The hosted Jev API becomes an optional comparison arm. See §6.1.*

## 1. What the source teaches

LifeOS picks a model lane and an effort for every prompt. It asks Jev, TypeSafe's "System One" decision model, through a judgment layer called Glance. Jev is reachable at `POST https://api.typesafe.ai/v1/systemone`, and on OpenRouter as `~typesafe/jev-latest`. The router code (`FrontDoor.ts`, `LaneQuestions.ts`, `LaneTrain.ts`, `RealPrompts.ts`) is not in the public LifeOS repo as of 2026-09-28. The lessons that carry over:

- **L1: Many small questions beat one big one.** A single seven-way choice reached 57% agreement. Nine to eighteen yes/no probabilities, combined by a small multinomial logistic regression, reached 90.1%.
- **L2: Synthetic test prompts lie.** The same model scored 85% on hand-written prompts and 43% on real ones. Real prompts are mostly short follow-ups ("y", "do it", "status?").
- **L3: A follow-up means nothing without the previous reply.**
  - The router feeds in the last ~800 characters of the assistant's reply.
  - It adds four questions about how the new prompt relates to that reply: approving it, reacting to it, correcting it, or starting something new.
- **L4: Fix the rules before training anything.**
  - Three labelling models agreed only 51.8% of the time.
  - Three rule clarifications raised that to 76.3%.
  - This was the biggest single gain, and it came from policy, not ML.
  - Each rule is capped at 16 words.
- **L5: "Stay inline" is the baseline to beat, and it's strong.**
  - Always keeping the work in the conversation scored 83.9%, and 85.1% when depth words trigger a hand-off.
  - A single Opus classifier call scored worse, 75.2%, because it handed off a third of all prompts.
- **L6: Honest evaluation.**
  - Gold labels are a majority vote of three blind labellers from two vendors.
  - Folds are split by session.
  - Results are compared with a paired McNemar test against the strongest baseline.
  - Training is deterministic.
  - The hand-off threshold is chosen by a sweep, and 50% won.
- **L7: Shadow before enforce.**
  - Every caller starts in shadow: it always gets "do not act", and its answer is logged next to what actually happened.
  - Enforce requires a registry row recording the agreement rate, the date, and the model it was measured on.
  - A model change demotes the caller back to shadow.
  - Each caller has a daily budget, and every call writes a ledger line.
  - The router itself is still in shadow.
- **L8: Separate dials stay separate.**
  - Model and effort are chosen independently.
  - A hard override ("think deeply") skips the classifier.
  - A prompt that looks like it contains a credential skips routing entirely.
  - PII is redacted before anything leaves the machine.

## 2. Where Soma stands

- **F1: Prompts that match no rule default to Algorithm.**
  - `classifyMode` returns `"algorithm"` whether or not an algorithm pattern matched (`src/algorithm-classifier.ts:129`, `:132`), and effort then falls through to E1 (`:79`).
  - This contradicts the "Algorithm is invoked, not defaulted" doctrine, and it's the inverse of L5.
  - This design request was itself classified "ALGORITHM E1 (auto)".
- **F2: The classifier sees only the prompt.**
  - The hook reads the prompt text alone (`src/adapters/claude-code/mode-classifier-hook.mjs:32`).
  - `"do it"` and `"go for it"` are hard-coded as *minimal* (`src/algorithm-classifier.ts:44-45`).
  - Per L3, those are exactly the prompts whose meaning comes from the previous reply. "Do it" after an Algorithm plan should continue that plan, not get a one-line acknowledgement.
- **F3: No ledger, so nothing to measure.** Classifications are neither logged nor compared with what happened next, so there's no shadow data.
- **F4: The rules live in three places:** the regex contract, the principal's MODES prose, and the Algorithm skill. There is no single short rule list for a labeller to read.
- **F5: The corpus exists.** Thousands of Claude Code transcript JSONLs sit under `~/.claude/projects/`, plus Codex and pi sessions. That's enough for a labelled set of 1,000 prompts.
- **F6: The rules already ship as data.** `ALGORITHM_CLASSIFIER_CONTRACT` is projected into pi-dev by `src/adapters/shared/algorithm-classifier-source.ts`. Learned weights can ride the same path.

## 3. What the router decides

LifeOS routes work to vendor workers. Soma's first job is choosing the working method. That gives three axes, each an independent head:

| Axis | Values | Consumer |
|---|---|---|
| **Mode** | `minimal` · `native` · `algorithm` | every substrate's mode hook |
| **Effort** | `E1`–`E5` (only when mode = algorithm) | Algorithm skill |
| **Lane** *(in scope, Q1)* | `inline` · `subagent-light` · `subagent-strong` · `second-opinion` | Claude Code Agent model/effort; Codex worker `--effort` |

Lane is the Soma equivalent of the LifeOS model grid. All three axes are in scope (Q1). Lane is labelled from step 3 on and gets its own head.

## 4. Rules first (≤16 words each)

This is a draft for the principal to edit. Labellers and the classifier read only this list.

1. Default is native. Algorithm is invoked by an explicit signal or genuinely multi-phase work.
2. Explicit tokens win: `e1`–`e5`, "algorithm", "ISA", "VSA", "ideal state", "ultracode".
3. Acknowledgements, ratings and thanks with no new request are minimal.
4. Approving my proposal continues my previous mode and effort.
5. Correcting my last action stays in the current mode; it never escalates alone.
6. Native if the ideal state fits in one line and is checkable at a glance.
7. Algorithm if the answer must be constructed and verified across several steps or files.
8. Length, file count and keywords alone never decide the mode.
9. Effort rises with cost of a subtle error, not with task size.
10. E4+ only for doctrine, security model, or cross-cutting architecture decisions.
11. "Analyze/review" is read-only; that never raises effort by itself.

Rule 6 comes from the retired LifeOS router, whose test was "ideal state pre-articulable in one line" (`RouterSystem.md`). Rules 4 and 5 are the L3 fix.

## 5. The questions

Every question is a yes/no answered with a probability (a Jev "noul"). The input is `{prompt, previous_reply_tail (≤800 chars), previous_mode, previous_effort}`, and all 16 questions go in one call. The previous effort is carried explicitly, because rule 4 (an approval continues the previous mode and effort) can't be honoured from a truncated reply tail. Laya and Jev both take the same `state + questions` request shape.

**Work (W1–W8)**
- W1 Does the prompt ask for something to be built, changed or fixed?
- W2 Is the expected result checkable at a glance once produced?
- W3 Does it span several files, systems or phases?
- W4 Does it touch deploys, secrets, auth, policy, hooks, or irreplaceable data?
- W5 Is it a lookup, status check, or opinion?
- W6 Is the approach already decided?
- W7 Does getting it right need real reasoning over contested evidence?
- W8 Is it analysis/review only, with no modification requested?

**Effort (E1–E4)**
- E1 Would a subtly wrong result be costly or hard to notice?
- E2 Must many interacting considerations be weighed at once?
- E3 Does the person explicitly ask for depth or thoroughness?
- E4 Is the work mostly breadth or volume rather than depth?

**Context (C1–C4)**
- C1 Is the prompt approving something I just proposed?
- C2 Is it only a reaction or acknowledgement?
- C3 Is it correcting or pushing back on what I just did?
- C4 Is it a new request unrelated to my previous reply?

**Plain features** need no model call:
- whether an explicit token appears
- whether a depth word appears
- prompt length (log-scaled)
- whether a previous reply exists
- the previous mode (one-hot)
- the previous effort (one-hot, none when the previous mode wasn't Algorithm)
- whether the prompt starts with a slash command

That gives 16 probabilities plus about 8 features. They feed three multinomial logistic regressions, one each for mode, effort and lane. Expect the question wording to change after the first labelling round, which is the L4 loop.

## 6. Architecture

```
UserPromptSubmit / pi input hook
  └─ pre-filter (deterministic, always local)
       explicit token → force · slash cmd → skip · credential-shaped → skip, log "skipped:secret"
  └─ QuestionBackend  (interface: answer(questions, state) → Record<id, p>)
       ├─ LayaBackend     PRIMARY · resident local laya-serve on 127.0.0.1, fine-tuned checkpoint, 300 ms timeout
       ├─ JevBackend      OPTIONAL comparison arm · TypeSafe/OpenRouter, redacts email/phone, 800 ms timeout
       └─ LocalBackend    regex/feature heuristics → pseudo-probabilities (no model, always available)
  └─ Combiner          weights = JSON data in the contract (ships to pi-dev like today's patterns)
  └─ Judgment registry  caller "mode-router": state shadow|enforce, threshold, budget, measured-on
  └─ Ledger            JSONL in the Soma home's private state directory (never committed)
                       {ts, caller, session, prompt_sha256, answers, decision, backend, latency_ms}
  └─ Output            shadow: current regex decides, router pick shown as advice line
                       enforce: router pick decides; regex is the timeout/fallback path
```

### 6.1 Question backend: Laya (local) first, Jev optional

[Laya](https://huggingface.co/convaiinnovations/laya) is an open-weights "System One" decision model, published 2026-09-18 under Apache 2.0. It answers the same three question types as Jev (noul, choice, score), and it runs on local hardware. Sources: the model card and README, plus a prior local smoke test from another project (2026-09-25, laptop M1 Pro CPU, laya 0.3.20, 10 synthetic one-line texts in DE/FR/IT/EN).

| | Laya | Jev |
|---|---|---|
| Where it runs | Locally. Python package `laya`. `laya-serve` speaks Jev's wire protocol (`POST /v1/systemone`), so one client can call either. `laya-ts` 0.1.0 exists but isn't on npm. There are no ONNX files on the Hub; one Python export is needed. | Hosted API, paid |
| Checkpoints | english (ModernBERT-large, 421M) · multilingual (mmBERT-base, 322M, 100+ languages) · typed-decisions (fine-tuned, 421M). About 614–803 MB each on disk. Default `max_len` 1,024 tokens per question sequence (0.3.21), raisable per call. | `jev-latest`, ~64k context |
| Latency | **Measured on laptop CPU**, per 1-question call: multilingual **49 ms**, english and typed-decisions ~111 ms. A 16-question call is far slower: see §6.2. Vendor T4 GPU figures: ~33–40 ms per question, ~72 ms for a batch of 10. | ~300 ms (vendor figure); ~1.1 s measured end-to-end from a laptop in another project |
| Zero-shot quality | **Base checkpoints are near chance.** Multilingual scored 0.352 on typed-decisions, where random is 0.318 and majority 0.461. The 0.766 figure comes from a checkpoint trained on that benchmark's own split. README: "a fast base to specialise, not a zero-shot decision engine". | strong zero-shot |
| Weak spots | Negation (issue #377: a negated request picked the action at p=0.9998). Noul answers follow their label wording (#156). Score position bias (#131). `laya-multilingual` ships without fitted temperatures. Its `confidence` formula differs from Jev's, so Jev thresholds don't transfer. About 20 options per choice at most. | — |

The smoke test showed the multilingual checkpoint with **no zero-shot signal on choice questions**. It answered the majority label on every case. But on a noul with explicit A/B labels, it **ranked every positive above every negative**, so its errors came only from where the 0.5 cut falls. That's what threshold and temperature fitting fix. With n=10 this is a hint, not an accuracy figure. It supports the plan: fine-tune, calibrate, and prefer nouls over choices.

What this means for the router:

- **At runtime, prompts stay on the machine.** Building and evaluating the router still uses hosted calls (labellers, the Opus baseline, the Jev arm). R1's screening covers all of them.
- **Fine-tuning is required, not optional.** The labelled set from step 3 becomes Laya's training data as well as the evaluation key. Nothing ships zero-shot.
- **Train locally, and never push.** The shipped fine-tune notebook trains on cloud GPUs and pushes to the HF Hub. A checkpoint trained on a principal's prompts is private data. Train on the laptop or another local host, and store it in the private Soma home.
- **Label volume and supervision.** The README's fine-tune set is ~30k questions.
  - A routing label does not determine the answers to W1–C4: the same `native` label can sit on an edit, a lookup or a correction. So arm A needs its own question-level labels.
  - In step 3, each labeller also answers the 16 questions per row, and the majority answer per question is the target. That gives 16k question labels from 1,000 prompts, which is thin for a per-question fine-tune.
  - That's one more reason to include arm B, which trains directly on 1,000 mode and effort labels.
- **Write every question positively.** Because of the negation bug (#377), no question text contains a negation (§5 already follows this). Check the labels for prompts that negate an action ("don't change anything, just tell me").
- **Two candidate designs to evaluate (step 5):**
  - **A — questions plus combiner:** Laya answers the 16 nouls, and the TypeScript logistic regression combines them. This follows L1.
  - **B — direct head:** Laya is fine-tuned straight onto the `mode` and `effort` labels as choice questions. Fewer moving parts. It competes with A on equal terms.
  - **C — embeddings plus head, no Python:** `bge-m3` embeddings, already served by local Ollama, of `{prompt, reply tail}`, fed to a TypeScript logistic regression. It needs no Laya and no Python. It's the cheapest local arm and the bar Laya has to clear.
- **Use the multilingual checkpoint.** Prompts mix German and English, and it was the fastest in the smoke test (49 ms). With the reply tail capped at ~600 characters, 99.5% of real states fit the 824-token per-question budget (§6.2). Truncate the prompt head and tail for the rest.
- **Keep the model resident.** The model can't load per prompt inside a hook (1.4 GB resident on CPU, §6.2). `laya-serve` runs as a launchd service on localhost, and the hook makes one HTTP call. If the service is down or slow, the regex decides.
- **Language boundary.** Laya is Python, which is approved (Q5). The runtime is `laya-serve` (D6). The TypeScript path is kept as a later swap.
  - The in-repo `laya-ts` (0.1.0, not on npm) exports a split ONNX model with `laya-ts/scripts/export_onnx.py` and checks it against PyTorch within 1e-4.
  - `onnxruntime-node`'s postinstall was blocked in an earlier Bun trial, so that path is unconfirmed.
- **Registry "measured on".** The row records the Laya checkpoint hash plus the calibration temperature. A new fine-tune drops the caller back to shadow.
- **`laya-serve` doesn't log bodies.** As of 0.3.21 it logs the traceback server-side, but a 500 still returns only "inference failed" to the client. The Soma ledger is the only record of the request, and the client must treat a 500 like a timeout: fall back to the regex.

**A Glance-shaped primitive, not a one-off (Q3: `soma judge`).** The registry and ledger are generic (`soma judge`), and the router is the first caller. Later candidates:
- feedback-candidate detection (the currently dormant capture pipeline)
- memory-recall relevance
- the "is this a correction?" signal the harness objective function wants

**Latency.** The hook already spawns `bun` on every prompt, so a subprocess cost is paid regardless. A localhost Laya call adds model time, a Jev call adds network time. The advice line should carry `latency_ms` so the cost is measured, not guessed. If the call exceeds the timeout, the regex decides.

### 6.2 Spike 3a results (2026-09-28)

Setup: laptop M1 Pro (8 performance cores), `laya[serve]` 0.3.21 in an isolated venv outside the Soma tree, torch 2.14, `multilingual` checkpoint at HF revision `55cf4c4ebb4e`, base weights (not fine-tuned), loaded offline from the local cache. `laya-serve` bound to 127.0.0.1, one checkpoint resident. The client is a Bun `fetch` with a timeout. Every figure is warm, measured after one discarded warm-up call per shape, with n=30–40 sequential calls. Latency states are synthetic. Token fit uses the real corpus, tokenized locally, and only aggregates were printed.

**How a call is computed.** Laya builds one sequence per question (state plus question head) and runs them all in one batched forward pass. So a call costs about *questions × state length*. The 16-noul call re-encodes the state 16 times.

**Latency, 16 nouls (arm A as specified in §5):**

| State (synthetic) | Input tokens | MPS p50 / p95 | CPU (8 threads) p50 / p95 |
|---|---|---|---|
| "do it" + 600-char reply tail | 3,074 | 334 / 339 ms | 734 / 903 ms |
| one-line DE request + tail | 3,442 | 383 / 560 ms | 805 / 1,242 ms |
| ~8-sentence prompt + tail | 7,106 | 780 / 833 ms | over the 2 s client timeout |

**Latency, smaller shapes (CPU, 8 threads):**

| Shape | Input tokens | p50 / p95 |
|---|---|---|
| Arm B: 2 choice questions (`mode`, `effort`) | 447–493 | 152–157 / 175–179 ms |
| 4 context nouls (C1–C4) | 856–948 | 220–257 / 236–388 ms |

Those states sit near the median. **Arm B across the real length distribution** (CPU, 8 threads, n=30, per-question state length matched to corpus percentiles):

| Per-question state | Input tokens | p50 / p95 |
|---|---|---|
| median ("do it" + tail) | 447 | 154 / 164 ms |
| corpus p95 (~300 tokens) | 601 | 198 / 237 ms |
| corpus p99 (~545 tokens) | 1,087 | 348 / 380 ms |
| full 1,024-token budget | 2,048 | 708 / 785 ms |

The laptop was under heavy unrelated load for these runs (load average ~21). A first pass under the same load gave a p95 of 1,271 ms at the corpus-p95 length; the rerun above reproduced the earlier median-state figure, so it is the one recorded.

**Arm C for comparison (D5):**
- Setup: local Ollama `bge-m3` (digest `790764642607`), one `/api/embed` call carrying the prompt and a 600-character reply tail, n=30 warm.
- Latency: p50 70 ms, p95 91 ms. The combiner adds one dot product per class, which is negligible.
- Across lengths (prompt plus 600-character tail, n=20): p95 111 ms at the corpus-p95 length, 165 ms at p99, 358 ms at the full budget.
- Cold: the first call after Ollama unloads the model takes 1.08 s. Ollama unloads an idle model after 5 minutes by default. A runtime arm C therefore needs a pinned `keep_alive`, or its first prompt after a pause falls back to the regex.
- Resident: 673 MB on the GPU while loaded.

**Resident memory:**
- CPU: 1.4 GB RSS after warm-up. That's about double the earlier 650–800 MB estimate, which was based on weight size.
- MPS: `ps` shows 222 MB, but the weights live in unified GPU memory that RSS doesn't count. Not measured.

**Token fit (1,000 real corpus rows, state = prompt + last 600 reply characters + previous mode and effort):**
- Prompt tokens: p50 10, p95 106, p99 427, max 6,153.
- State tokens: p50 200, p95 295, p99 575.
- The per-question state budget is `max_len − head_max_len − 8` = 1024 − 192 − 8 = 824 tokens. The default `max_len` is 1,024 in 0.3.21. The earlier ~768 assumption was wrong.
- 5 of 1,000 states (0.5%) exceed the budget, and 4 of those because of the prompt alone.
- The synthetic "do it" state (~190 tokens per question) sits at the real median, so the first latency row is the typical case.

**Negation probe (base checkpoint, so noise until fine-tuned):**
- "Don't change anything, just explain…": W1 = 0.304, W8 = 0.401.
- "Change the lease so it survives restarts": W1 = 0.142, W8 = 0.076.
- W1 ranks the negated prompt *above* the real change request, which is the #377 failure shape. This is recorded as a check to rerun after fine-tuning, not as a finding.

**Verdict against the ≤300 ms p95 budget:**
- **No-go: arm A as specified (16 nouls, synchronous).** It misses on both devices even at the median state (MPS p95 339 ms, CPU p95 903 ms). MPS then degrades with prompt length.
- **Go, with a tail: arm B's shape.** Two choice questions stay under 300 ms up to the corpus-p95 state (p95 237 ms). Between the p95 and p99 lengths they cross the budget, so an estimated 1–5% of prompts, the longest, would time out to the regex.
- **Go: arm C** (p95 91 ms warm, 165 ms at the p99 length), provided `keep_alive` keeps the model resident. Only states near the full budget exceed 300 ms.
- **Borderline: a reduced arm A** (about 4 nouls). CPU p95 is 236–388 ms.
- **Measured, so nothing to estimate here:** R9's memory figure is now 1.4 GB on CPU.

What the principal decided in D7, and what stays open:
- Decided: arm A stays an evaluation arm that runs off the hot path. In shadow, the pick is only advice and can be computed after the prompt has been answered, so the latency budget applies only to enforce.
- Open: a reduced arm A (the questions that pay for themselves) may become an enforce candidate once step 5 shows which ones do.
- Open: whether 1.4 GB always-resident is acceptable, which is D6's revisit trigger.

## 7. Build order

Each step has its own exit check.

0. **Ledger and "native by default" (no ML).**
   - Log every classification.
   - Flip the F1 fallback from algorithm to native (D1).
   - *Exit:* ledger lines appear, and the gap between regex and always-native can be measured.
1. **Rules.**
   - The principal edits §4.
   - *Exit:* one file, every rule ≤16 words, and the MODES doctrine points to it.
2. **Corpus (`soma router corpus`).** A TypeScript tool that walks Claude, Codex and pi transcripts.
   - Keep only human-typed interactive prompts.
   - Drop meta, tool_result, hook-injected, sidechain/subagent, pasted-notification and `<command-*>` entries.
   - Attach the previous assistant tail and the previous mode and effort. Where the hook did not classify the previous prompt, both are recorded as unknown (null), never carried over from an earlier prompt.
   - Sample 1,000 prompts.
   - Store the output in the Soma home's private state directory, never committed.
3. **Labels.**
   - Three blind labellers from at least two vendors: Opus 5.5, Fable 5.1, and a Codex/GPT model. Every row passes R1's local screen first.
   - Label the first 300 and measure agreement.
   - Below ~75%, go back to step 1 before labelling the rest (L4).
3a. **Laya spike on `laya-serve`** (can run in parallel with steps 1–3).
   - The single-question CPU latency is already known (49 ms, multilingual). What's still missing is the **16-noul batch**.
   - Install `laya[serve]` in an isolated venv on the laptop, CPU only.
   - Measure warm latency for one call carrying 16 nouls, resident memory, and the token cost of the state plus question texts against `max_len`.
   - Probe a negated prompt ("don't change anything, just explain") against W1.
   - *Exit:* numbers recorded; go/no-go against a p95 budget of ≤300 ms.
   - **Done 2026-09-28, see §6.2.** Arm A as specified is a no-go, and arm B's shape is a go. D7 records the decision.
4. **Questions, fine-tune and combiner.**
   - Fine-tune the multilingual Laya checkpoint only on the training folds, so each fold is scored by a model that never saw it. Calibrate its temperature on a held-out slice.
   - Arm A: run the §5 questions through the fine-tuned Laya, then train a deterministic logistic regression in TypeScript on its answers.
   - Arm B: fine-tune Laya directly on the mode and effort labels.
   - Arm C: `bge-m3` embeddings with a TypeScript logistic regression. It needs no Laya, so it can start first.
   - Score all arms with 5 folds split by session.
5. **Evaluate.**
   - Candidates: Laya arm A, Laya arm B, arm C, LocalBackend plus combiner, and Jev arm A (evaluation only, with R1's redaction and credential skip applied).
   - Baselines: always-native, native plus depth words, the current regex, and one Opus call (screened per R1).
   - Report per-axis accuracy and the count of prompts escalated where the key says native.
   - Run a McNemar test against the best baseline, and a threshold sweep.
   - Add a test that pins the deterministic score.
6. **Shadow.**
   - Run live with advice only.
   - Enforce requires a registry row with agreement, date and backend model.
   - A model change demotes back to shadow automatically.

## 8. Risks

- **R1: Egress.** The router at runtime stays on the machine: Laya, LocalBackend and the regex are all local. Building and evaluating it is a different matter. Every hosted call sends real prompts and reply tails off the machine:
  - the three labellers in step 3 (Opus 5.5 and Fable 5.1 via Anthropic, a Codex/GPT model via OpenAI)
  - the one-Opus-call baseline in step 5
  - the Jev arm in step 5 (TypeSafe or OpenRouter)

  Prompts routinely contain employer and client material. Prompts from Claude Code transcripts have already reached Anthropic, so for those rows OpenAI and TypeSafe are the **new recipients**. Rows from Codex or pi sessions have not necessarily reached Anthropic, so for them Anthropic is a new recipient too. Each row records its source substrate, and the enablement below is decided per recipient and source. TypeSafe's public API reference says nothing about retention, training use or residency (checked 2026-09-28).

  Mitigations apply to **every** hosted call, not just Jev:
  - A local screen runs over both the prompt and the reply tail before transmission. It redacts email addresses and phone numbers, and drops any row that looks like it holds a credential.
  - Rows the screen drops stay out of hosted labelling. They're labelled locally by the principal, or left out and counted.
  - Each new recipient (OpenAI, TypeSafe) is enabled explicitly for this evaluation, and its data terms are read first.
  - JevBackend stays off by default at runtime, opt-in per home.
- **R2: Portability.** Weights and questions must be data in the contract, not code. Extend the equivalence test pattern in `test/pi-dev-classifier-projection.test.ts` to cover them.
- **R3: Latency.** See §6. A hard timeout plus fallback means the router never blocks a prompt.
- **R4: Label reliability.** Agreement between labellers is not an accuracy ceiling. A classifier can match the majority key closely even when individual labellers disagree. But low agreement means the key itself is unreliable, so a high score against it proves little. Measure agreement before tuning the model, and fix the rules (L4) until the key is trustworthy.
- **R5: Corpus hygiene.** Hook output and subagent chatter poison the labels. Step 2 needs a check that samples its output and inspects it.
- **R6: Per-person fit.** Weights trained on one principal's prompts don't transfer. Other homes need either a generic default set or per-home retraining. A fine-tuned Laya checkpoint makes this sharper: it is a per-home artifact, never a shipped default.
- **R7: Laya is new and unreplicated.** The repo was created 2026-09-18, it's at version 0.x, and it had 26 open issues when read on 2026-09-25. Its benchmark numbers are its own, and the Jev comparisons in its README are third-party, not head-to-head. The spike and step 5 are the only numbers that count.
- **R8: Context window.** The default budget is 1,024 tokens per question sequence, versus Jev's ~64k. Only 0.5% of real states exceed it (§6.2), but each question re-encodes the state, so cost grows with questions × state length.
- **R11: Known Laya failure modes.** Negation (#377), label-wording sensitivity (#156), and score position bias (#131). Mitigations: positive question wording, nouls rather than scores, and the effort head trained as a choice rather than a score.
- **R9: Python and a resident service.** This brings a second language and a long-running local service (1.4 GB RSS on CPU, measured in §6.2) into a Bun-only stack. It needs a launchd unit, a health check, and a `soma doctor` probe. It's contained by the regex fallback, never by blocking a prompt.
- **R10: Probability quality.** Raw Laya probabilities are overconfident. Temperature calibration is part of the fine-tune step, and the registry threshold is set on calibrated outputs only.

## 9. Open questions for the principal

All answered 2026-09-28.

- **Q1: yes.** The Lane axis (subagent model and effort) is in scope, alongside Mode and Effort.
- **Q2: yes.** The Jev arm may run for evaluation. R1's screening applies to it and to every other hosted call.
- **Q3: `soma judge`.** A generic, Glance-shaped registry, with the router as its first caller.
- **Q4: yes.** D1 ships now, independent of the rest.
- **Q5 (answered 2026-09-28):** Python is approved for Laya's fine-tuning, calibration and the `laya-serve` runtime. It lives in an isolated venv outside the Soma source tree.
- **Q6 (answered 2026-09-28):** The runtime is `laya-serve`. See D6.

## 10. Proposed decisions

- **D1:** Flip the unmatched-prompt fallback to native (F1). It's cheap, it follows L5, and it matches existing doctrine.
- **D2:** Pass the previous reply tail and previous mode into the classifier contract, even for the regex path. Stop treating "do it" as minimal (F2).
- **D3:** Build the ledger before any model. Without it, no later step can be measured.
- **D4:** Laya, local and fine-tuned, is the primary question backend. Jev is at most an evaluation arm. LocalBackend and the regex remain the always-available fallback.
- **D5:** Arm C (`bge-m3` plus a TypeScript head) runs first. It needs no Laya, and Laya has to beat it to justify its Python dependency and resident service.
- **D6 (agreed 2026-09-28):** Run Laya as `laya-serve` (Python) for the spike and the shadow phase.
  - **Why it's fast to evidence:** it needs no custom code, and it already ran on the laptop.
  - **Why it can't drift:** the fine-tuned checkpoint loads directly in the same code that trained it.
  - **Why the swap stays cheap:** it speaks Jev's `/v1/systemone` protocol. Any replacement service must speak the same protocol, so a swap only changes the URL.
  - **Why ONNX doesn't avoid a service:** the Claude Code hook spawns a fresh process per prompt (`src/adapters/claude-code/mode-classifier-hook.mjs:40`). Whatever runtime is used, the model must live in a resident service.
  - **Revisit and move to ONNX via `laya-ts` in a Bun service when either holds:**
    - the spike shows PyTorch's resident memory is too high for an always-on service, or
    - loading the model inside pi-dev's long-lived process becomes worth having.
  - **Before any such swap:** confirm that `onnxruntime-node` installs and loads under Bun (possibly via `trustedDependencies`).
- **D7 (agreed 2026-09-28, after spike 3a):** Arm A's 16 nouls miss the latency budget on this laptop (§6.2).
  - Arm A stays an evaluation arm, run offline or after the answer, never inside the hook's timeout.
  - Enforce considers only shapes measured under budget: arm B (under budget to the corpus-p95 length) and arm C (under budget to beyond p99). A reduced arm A of about 4 nouls is borderline. LocalBackend isn't built yet, so it has no latency figure.
  - In shadow, a Laya call may run after the answer, because shadow output is advice only.
