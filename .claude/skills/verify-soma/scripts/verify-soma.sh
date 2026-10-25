#!/usr/bin/env bash
# verify-soma: drive the real soma CLI against a disposable home.
# Usage: verify-soma.sh <launch|doctor|soma|raw|hook|real-home-check|cleanup> <run-dir> [args...]
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../../../.." && pwd)"
CMD="${1:-}"; RUN="${2:-}"

die() { echo "verify-soma: $*" >&2; exit 2; }
[ -n "$CMD" ] || die "usage: verify-soma.sh <launch|doctor|soma|raw|hook|real-home-check|cleanup> <run-dir> [args...]"
[ -n "$RUN" ] || die "missing <run-dir>"
case "$RUN" in /*) ;; *) RUN="$PWD/$RUN" ;; esac
shift 2

H="$RUN/home"
EV="$RUN/evidence"

# Isolated env: scratch HOME, no bus publishing, no live Soma/PAI pointers.
iso() { env -u SOMA_PRINCIPAL -u SOMA_HOME -u PAI_DIR HOME="$H" "$@"; }

# Run a command, append command + stdout/stderr + exit code to the transcript.
record() {
  local log="$EV/transcript.log" code
  mkdir -p "$EV"
  { echo "\$ $*"; } >>"$log"
  "$@" > >(tee -a "$log") 2> >(tee -a "$log" >&2)
  code=$?
  echo "[exit $code]" >>"$log"
  return $code
}

case "$CMD" in
  launch)
    [ -e "$H" ] && die "$H already exists; pick a new run dir or run cleanup"
    mkdir -p "$H" "$EV"
    touch "$RUN/.started"
    record iso bun "$REPO/src/cli.ts" init --apply --substrate claude-code --home-dir "$H" --soma-home "$H/.soma" || die "init failed"
    [ -f "$H/.claude/rules/soma/CONTEXT.md" ] || die "not ready: $H/.claude/rules/soma/CONTEXT.md missing"
    echo "READY run=$RUN"
    ;;
  doctor)
    ok=0
    [ -f "$RUN/.started" ] || { echo "FAIL run dir was not created by launch: $RUN"; ok=1; }
    [ -d "$H/.soma/memory" ] || { echo "FAIL no soma home at $H/.soma"; ok=1; }
    [ -f "$H/.claude/rules/soma/CONTEXT.md" ] && echo "ok   claude-code projection present" || { echo "FAIL claude-code projection missing (reinstall: soma install claude-code --apply)"; ok=1; }
    want="soma $(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$REPO/package.json")"
    got="$(iso bun "$REPO/src/cli.ts" --version 2>&1)"
    [ "$got" = "$want" ] && echo "ok   version $got (checkout $REPO)" || { echo "FAIL version '$got' != package.json '$want'"; ok=1; }
    [ -n "${SOMA_PRINCIPAL:-}" ] && echo "note SOMA_PRINCIPAL is set in the caller; the helper unsets it for every drive"
    grep -q "$H/.claude/hooks/soma" "$H/.claude/settings.json" 2>/dev/null && echo "ok   hooks in settings.json point into the scratch home" || echo "note settings.json has no scratch hook entries (uninstalled?)"
    exit $ok
    ;;
  soma)
    [ -d "$H/.soma" ] || die "no soma home; run launch first"
    record iso bun "$REPO/src/cli.ts" "$@" --home-dir "$H" --soma-home "$H/.soma"
    ;;
  raw)
    # For subcommands that reject --home-dir/--soma-home (classify, policy check).
    record iso bun "$REPO/src/cli.ts" "$@"
    ;;
  hook)
    event="${1:?hook <event> <json-payload>}"; payload="${2:?json payload}"
    hookjs="$H/.claude/hooks/soma/soma-claude-code-hook.mjs"
    [ -f "$hookjs" ] || die "hook not installed at $hookjs"
    mkdir -p "$EV"
    echo "\$ hook $event <<< $payload" >>"$EV/transcript.log"
    printf '%s' "$payload" | iso bun "$hookjs" "$event" > >(tee -a "$EV/transcript.log") 2> >(tee -a "$EV/transcript.log" >&2)
    code=$?; echo "[exit $code]" >>"$EV/transcript.log"; exit $code
    ;;
  real-home-check)
    # Lists principal-home files changed since launch. memory/STATE is excluded:
    # the live substrate session's own hooks write there continuously.
    [ -f "$RUN/.started" ] || die "no .started marker"
    changed="$(find "$HOME/.soma" "$HOME/.claude/rules/soma" "$HOME/.claude/skills" "$HOME/.claude/settings.json" \
      -newer "$RUN/.started" -type f -not -path '*/memory/STATE/*' -not -path '*/.git/*' 2>/dev/null)"
    if [ -z "$changed" ]; then echo "ok   principal home untouched since launch"; exit 0; fi
    echo "CHECK files changed since launch (may be the live session; inspect before blaming the run):"
    echo "$changed"; exit 1
    ;;
  cleanup)
    [ -f "$RUN/.started" ] || die "refusing: $RUN was not created by launch"
    rm -rf "$H" "$RUN/.started"
    [ -d "$EV" ] && echo "cleaned $H; evidence kept at $EV" || echo "cleaned $H; no evidence dir"
    ;;
  *) die "unknown command: $CMD" ;;
esac
