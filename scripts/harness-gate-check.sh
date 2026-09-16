#!/usr/bin/env bash
#
# Weekly harness regression gate — the scheduled half of the harness eval
# (docs/harness-objective-function.md, loop-closure plan T6). CI runs the metric
# unit tests on every PR; this runs `harness-eval --check` against the LIVE
# soma-home data CI does not have, and alerts on a nonzero exit.
#
# Exit codes, one per outcome, so a broken gate never reads as a red one (#681):
#   0  ok           — measured, no regression vs the committed baseline
#   1  regressed    — measured, harness-eval printed its REGRESSION verdict
#   2  could-not-run — nothing was measured (missing script, crash, bad baseline)
#   3  guard        — baseline differs from HEAD, the check was not attempted
# Each run logs one `RESULT <outcome>` line so the log states which it was.
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

# launchd hands us a minimal PATH; make sure bun is reachable.
export PATH="${HOME}/.bun/bin:/usr/local/bin:/opt/homebrew/bin:${PATH}"

STAMP="$(date '+%Y-%m-%dT%H:%M:%S%z')"
cd "${REPO_DIR}" || { printf "%s FATAL cannot cd %s\nRESULT could-not-run\n\n" "${STAMP}" "${REPO_DIR}" >>"${LOG_FILE}"; exit 2; }

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
if ! git -C "${REPO_DIR}" diff --quiet HEAD -- "${BASELINE_REL}" 2>/dev/null; then
  MSG="baseline ${BASELINE_REL} differs from committed HEAD — a green check cannot be trusted (possible uncommitted re-baseline). Commit or restore it."
  printf '%s GUARD baseline-not-committed: %s\n\n' "${STAMP}" "${MSG}" >>"${LOG_FILE}"
  osascript -e "display notification \"${MSG}\" with title \"Soma harness gate: baseline not committed\"" 2>/dev/null || true
  exit 3
fi

OUTPUT="$(bun run harness-eval --check 2>&1)"
STATUS=$?

# Classify on harness-eval's own verdict, not on the exit code alone: `bun run`
# of a missing script, an uncaught throw, and a real regression all exit 1.
# Only the script's "REGRESSION:" line means something was measured and degraded.
if [ "${STATUS}" -eq 0 ]; then
  RESULT="ok"; CODE=0
elif [ "${STATUS}" -eq 1 ] && grep -q '^REGRESSION:' <<<"${OUTPUT}"; then
  RESULT="regressed"; CODE=1
else
  RESULT="could-not-run"; CODE=2
fi

printf '%s exit=%s\nRESULT %s\n%s\n\n' "${STAMP}" "${STATUS}" "${RESULT}" "${OUTPUT}" >>"${LOG_FILE}"

# Surface a failure. macOS notification for the interactive case, plus the log
# above for the durable record.
if [ "${RESULT}" = "regressed" ]; then
  SUMMARY="$(printf '%s' "${OUTPUT}" | grep -E '✗|REGRESSION' | head -3 | tr "\n" " " | tr -d "\"\\\\")"
  osascript -e "display notification \"${SUMMARY:-see ${LOG_FILE}}\" with title \"Soma harness gate: REGRESSION\"" 2>/dev/null || true
elif [ "${RESULT}" = "could-not-run" ]; then
  SUMMARY="$(printf '%s' "${OUTPUT}" | tail -1 | tr -d "\"\\\\")"
  osascript -e "display notification \"${SUMMARY:-see ${LOG_FILE}}\" with title \"Soma harness gate: COULD NOT RUN\"" 2>/dev/null || true
fi

exit "${CODE}"
