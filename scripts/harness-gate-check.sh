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
