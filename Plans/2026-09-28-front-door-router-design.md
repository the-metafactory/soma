# Soma front-door router — design proposal

*2026-09-28 · status: proposal, nothing implemented · source: [How Jev Picks the Model and Effort for Every Prompt](https://danielmiessler.com/blog/glance-routes-model-and-effort) (LifeOS, 2026-09-24)*

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
| **Lane** *(optional, Q1)* | `inline` · `subagent-light` · `subagent-strong` · `second-opinion` | Claude Code Agent model/effort; Codex worker `--effort` |

Lane is the Soma equivalent of the LifeOS model grid. Mode and Effort are what Soma needs now.

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

Every question is a yes/no answered with a probability (a Jev "noul"). The input is `{prompt, previous_reply_tail (≤800 chars), previous_mode}`, and all 16 questions go in one call.

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
- whether the prompt starts with a slash command

That gives 16 probabilities plus about 8 features. They feed two multinomial logistic regressions, one for mode and one for effort, and a third for lane if Q1 says yes. Expect the question wording to change after the first labelling round, which is the L4 loop.

## 6. Architecture

```
UserPromptSubmit / pi input hook
  └─ pre-filter (deterministic, always local)
       explicit token → force · slash cmd → skip · credential-shaped → skip, log "skipped:secret"
  └─ QuestionBackend  (interface: answer(questions, state) → Record<id, p>)
       ├─ JevBackend      TypeSafe/OpenRouter, redacts email/phone, 800 ms timeout
       └─ LocalBackend    regex/feature heuristics → pseudo-probabilities (offline, zero egress)
  └─ Combiner          weights = JSON data in the contract (ships to pi-dev like today's patterns)
  └─ Judgment registry  caller "mode-router": state shadow|enforce, threshold, budget, measured-on
  └─ Ledger            JSONL in the Soma home's private state directory (never committed)
                       {ts, caller, session, prompt_sha256, answers, decision, backend, latency_ms}
  └─ Output            shadow: current regex decides, router pick shown as advice line
                       enforce: router pick decides; regex is the timeout/fallback path
```

**A Glance-shaped primitive, not a one-off (Q3).** The registry and ledger are generic (`soma judge`), and the router is the first caller. Later candidates:
- feedback-candidate detection (the currently dormant capture pipeline)
- memory-recall relevance
- the "is this a correction?" signal the harness objective function wants

**Latency.** The hook already spawns `bun` on every prompt, so a subprocess cost is paid regardless. A Jev round trip adds network time on top of that. The advice line should carry `latency_ms` so the cost is measured, not guessed. If the call exceeds the timeout, the regex decides.

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
   - Attach the previous assistant tail and the previous mode.
   - Sample 1,000 prompts.
   - Store the output in the Soma home's private state directory, never committed.
3. **Labels.**
   - Three blind labellers from at least two vendors: Opus 5.5, Fable 5.1, and a Codex/GPT model.
   - Label the first 300 and measure agreement.
   - Below ~75%, go back to step 1 before labelling the rest (L4).
4. **Questions and combiner.**
   - Run the §5 questions over the labelled set on both backends.
   - Train a deterministic logistic regression in TypeScript, no Python.
   - Score with 5 folds split by session.
5. **Evaluate.**
   - Baselines: always-native, native plus depth words, the current regex, and one Opus call.
   - Report per-axis accuracy and the count of prompts escalated where the key says native.
   - Run a McNemar test against the best baseline, and a threshold sweep.
   - Add a test that pins the deterministic score.
6. **Shadow.**
   - Run live with advice only.
   - Enforce requires a registry row with agreement, date and backend model.
   - A model change demotes back to shadow automatically.

## 8. Risks

- **R1: Egress.**
  - JevBackend sends the prompt plus the reply tail to TypeSafe or OpenRouter.
  - The public API reference says nothing about retention, training use or residency (checked 2026-09-28).
  - Prompts routinely contain employer and client material.
  - Mitigations:
    - JevBackend is off by default, opt-in per home.
    - Email and phone numbers are redacted.
    - Prompts that look like they hold a credential skip routing entirely.
    - LocalBackend is always available.
    - Read the provider's data terms before anyone opts in.
- **R2: Portability.** Weights and questions must be data in the contract, not code. Extend the equivalence test pattern in `test/pi-dev-classifier-projection.test.ts` to cover them.
- **R3: Latency.** See §6. A hard timeout plus fallback means the router never blocks a prompt.
- **R4: Label ceiling.** No classifier beats the labellers' own agreement. Measure agreement before tuning the model.
- **R5: Corpus hygiene.** Hook output and subagent chatter poison the labels. Step 2 needs a check that samples its output and inspects it.
- **R6: Per-person fit.** Weights trained on one principal's prompts don't transfer. Other homes need either a generic default set or per-home retraining.

## 9. Open questions for the principal

- **Q1:** Is the Lane axis (subagent model/effort) in scope, or only Mode and Effort for now? LifeOS 7.0 retired modes entirely, and its new router picks only model and effort.
- **Q2:** Is sending prompts to Jev acceptable at all, given R1? Or does Soma stay LocalBackend-only until the provider's data terms are known?
- **Q3:** A generic `soma judge` registry (Glance-shaped), or a router-only module?
- **Q4:** Should the step 0 native-by-default flip (D1) ship now, independent of the rest?

## 10. Proposed decisions

- **D1:** Flip the unmatched-prompt fallback to native (F1). It's cheap, it follows L5, and it matches existing doctrine.
- **D2:** Pass the previous reply tail and previous mode into the classifier contract, even for the regex path. Stop treating "do it" as minimal (F2).
- **D3:** Build the ledger before any model. Without it, no later step can be measured.
