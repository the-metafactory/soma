#!/usr/bin/env bash
#
# Weekly harness regression gate — the scheduled half of the harness eval
# (docs/harness-objective-function.md, loop-closure plan T6). CI runs the metric
# unit tests on every PR; this runs `harness-eval --check` against the LIVE
# soma-home data CI does not have, and alerts on a nonzero exit (a regression
# past tolerance vs the committed baseline).
#
# Invoked by the launchd agent ch.switch.soma.harness-gate (see
# scripts/launchd/ch.switch.soma.harness-gate.plist). Safe to run by hand.
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
cd "${REPO_DIR}" || { echo "${STAMP} FATAL cannot cd ${REPO_DIR}" >>"${LOG_FILE}"; exit 2; }

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

printf '%s exit=%s\n%s\n\n' "${STAMP}" "${STATUS}" "${OUTPUT}" >>"${LOG_FILE}"

if [ "${STATUS}" -ne 0 ]; then
  # Surface the failure. macOS notification for the interactive case, plus the
  # log above for the durable record.
  SUMMARY="$(printf '%s' "${OUTPUT}" | grep -E '✗|REGRESSION' | head -3 | tr '\n' ' ')"
  osascript -e "display notification \"${SUMMARY:-see ${LOG_FILE}}\" with title \"Soma harness gate: REGRESSION\"" 2>/dev/null || true
fi

exit "${STATUS}"
