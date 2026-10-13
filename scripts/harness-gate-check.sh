#!/usr/bin/env bash
#
# Weekly harness regression gate — the scheduled half of the harness eval
# (docs/harness-objective-function.md, loop-closure plan T6). CI runs the metric
# unit tests on every PR; this runs `harness-eval --check` against the LIVE
# soma-home data CI does not have, and reports each run to Vigil.
#
# Exit codes, one per outcome, so a broken gate never reads as a red one (#681):
#   0  ok           — measured, harness-eval printed its OK verdict
#   1  regressed    — measured, harness-eval printed its REGRESSION verdict
#   2  could-not-run — no verdict (missing script, crash, bad baseline, git error)
#   3  guard        — baseline differs from HEAD, the check was not attempted
# Each run logs one `RESULT <outcome>` line so the log states which it was.
#
# Each run is one `job` run on the run ledger (node #821): `soma run finished`
# publishes one execution.run.finished envelope. The outcome is the job's own
# result (ok and regressed both `succeeded`, could-not-run `failed`, guard
# `blocked`); a measured verdict also carries `state soma:harness ok|regressed`.
# Any report other than `run finished: published` is logged as one `EMIT
# failed` line naming why: `exit=<n>` when soma is missing or exits nonzero,
# `status=<failed|rejected|disabled>` when the verb ran but published nothing.
# It never changes the RESULT line or the exit code.
#
# Invoked by the launchd agent ch.switch.soma.harness-gate (see
# scripts/launchd/ch.switch.soma.harness-gate.plist.template). Safe to run by hand.
#
# It NEVER re-baselines — a red gate is the signal to investigate, not to move
# the goalposts (see the objective doc's re-baseline authority rule).
set -uo pipefail

# Resolve the repo root from this script's own location so the job is
# location-independent (no hardcoded repo path in the plist beyond the wrapper).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_DIR="${HOME}/Library/Logs/soma"
LOG_FILE="${LOG_DIR}/harness-gate.log"
mkdir -p "${LOG_DIR}"

# launchd hands us a minimal PATH; make sure bun and arc's `soma` shim
# ($HOME/.local/bin) are reachable.
export PATH="${HOME}/.local/bin:${HOME}/.bun/bin:/usr/local/bin:/opt/homebrew/bin:${PATH}"

# UTC with a `Z`: the run ledger takes ISO 8601 with a colon offset, which BSD
# `date` cannot print for local time.
STAMP="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# finish <exit-code> <outcome> [<state-value>]: report this run to the run
# ledger, close its log entry, and exit. Every exit path comes through here.
finish() {
  local code="$1" outcome="$2" state="${3:-}"
  local args=(run finished --kind job --ref soma:harness-gate --outcome "${outcome}" --started-at "${STAMP}" --detail-ref "${LOG_FILE}")
  if [ -n "${state}" ]; then
    args+=(--state-subject soma:harness --state-value "${state}")
  fi
  local emit_output emit_status
  emit_output="$(soma "${args[@]}" 2>>"${LOG_FILE}")"
  emit_status=$?
  if [ -n "${emit_output}" ]; then
    printf '%s\n' "${emit_output}" >>"${LOG_FILE}"
  fi
  # The verb exits 0 whether or not it published; its last stdout line says which.
  local emit_result="${emit_output##*$'\n'}"
  if [ "${emit_status}" -ne 0 ]; then
    printf '%s EMIT failed exit=%s\n' "${STAMP}" "${emit_status}" >>"${LOG_FILE}"
  elif [ "${emit_result}" != "run finished: published" ]; then
    local reported="${emit_result#run finished: }"
    printf '%s EMIT failed status=%s\n' "${STAMP}" "${reported:-none}" >>"${LOG_FILE}"
  fi
  printf '\n' >>"${LOG_FILE}"
  exit "${code}"
}

cd "${REPO_DIR}" || { printf "%s FATAL cannot cd %s\nRESULT could-not-run\n" "${STAMP}" "${REPO_DIR}" >>"${LOG_FILE}"; finish 2 failed; }

# Baseline-integrity guard (Sage review, PR #455): a green --check only means
# something if the baseline it compared against is the committed one. The
# `--write-baseline` command overwrites the working file in place, so a session
# could silently lower the bar and the weekly check would report green while
# hiding a real regression. Refuse to trust a baseline that differs from HEAD —
# a legitimate re-baseline is a COMMIT (reviewable in git history), never an
# uncommitted overwrite. (This catches the silent-overwrite case; a re-baseline
# committed to a local unpushed branch is still git-reviewable, which is the
# bar the objective doc claims.)
BASELINE_REL="scripts/harness-eval-baseline.json"
# Confirm HEAD resolves first: outside a repo `git diff --quiet HEAD` also exits
# 1, the same code as a real difference, so a git failure would read as a guard.
if ! git -C "${REPO_DIR}" rev-parse --verify -q HEAD >/dev/null 2>&1; then
  printf '%s FATAL cannot resolve git HEAD in %s\nRESULT could-not-run\n' "${STAMP}" "${REPO_DIR}" >>"${LOG_FILE}"
  finish 2 failed
fi
git -C "${REPO_DIR}" diff --quiet HEAD -- "${BASELINE_REL}" 2>/dev/null
DIFF_STATUS=$?
if [ "${DIFF_STATUS}" -gt 1 ]; then
  printf '%s FATAL git diff exited %s checking %s\nRESULT could-not-run\n' "${STAMP}" "${DIFF_STATUS}" "${BASELINE_REL}" >>"${LOG_FILE}"
  finish 2 failed
fi
if [ "${DIFF_STATUS}" -eq 1 ]; then
  MSG="baseline ${BASELINE_REL} differs from committed HEAD — a green check cannot be trusted (possible uncommitted re-baseline). Commit or restore it."
  printf '%s GUARD baseline-not-committed: %s\nRESULT guard\n' "${STAMP}" "${MSG}" >>"${LOG_FILE}"
  finish 3 blocked
fi

# The package.json script the gate runs. test/harness-gate-check.test.ts reads
# this assignment and checks package.json still defines it (#681).
EVAL_SCRIPT="harness-eval"
OUTPUT="$(bun run "${EVAL_SCRIPT}" --check 2>&1)"
STATUS=$?

# Classify on harness-eval's own verdict, not on the exit code alone: `bun run`
# of a missing script, an uncaught throw, and a real regression all exit 1, and
# an exit 0 alone does not prove anything was measured. Only the script's "OK:"
# or "REGRESSION:" line is a verdict.
if [ "${STATUS}" -eq 0 ] && grep -q '^OK:' <<<"${OUTPUT}"; then
  RESULT="ok"; CODE=0; OUTCOME="succeeded"; STATE="ok"
elif [ "${STATUS}" -eq 1 ] && grep -q '^REGRESSION:' <<<"${OUTPUT}"; then
  RESULT="regressed"; CODE=1; OUTCOME="succeeded"; STATE="regressed"
else
  RESULT="could-not-run"; CODE=2; OUTCOME="failed"; STATE=""
fi

printf '%s exit=%s\nRESULT %s\n%s\n' "${STAMP}" "${STATUS}" "${RESULT}" "${OUTPUT}" >>"${LOG_FILE}"
finish "${CODE}" "${OUTCOME}" "${STATE}"
