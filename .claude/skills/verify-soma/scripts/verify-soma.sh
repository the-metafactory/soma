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
REAL_EVENTS="$HOME/.soma/memory/STATE/events.jsonl"

# Isolated env: scratch HOME, no bus publishing, no live Soma/PAI pointers.
iso() { env -u SOMA_PRINCIPAL -u SOMA_HOME -u PAI_DIR HOME="$H" "$@"; }

# Run a command (stdin passes through), then append command, stdout, stderr
# and exit code to the transcript in that order.
record() {
  local log="$EV/transcript.log" out err code
  mkdir -p "$EV"
  out="$(mktemp)"; err="$(mktemp)"
  "$@" >"$out" 2>"$err"
  code=$?
  { echo "\$ $*"; cat "$out" "$err"; echo "[exit $code]"; } >>"$log"
  cat "$out"; cat "$err" >&2
  rm -f "$out" "$err"
  return $code
}

case "$CMD" in
  launch)
    [ -e "$H" ] && die "$H already exists; pick a new run dir or run cleanup"
    mkdir -p "$H" "$EV"
    touch "$RUN/.started"
    if [ -f "$REAL_EVENTS" ]; then wc -l <"$REAL_EVENTS" | tr -d ' ' >"$RUN/.real-events-lines"; else echo 0 >"$RUN/.real-events-lines"; fi
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
    # Every hook script path in settings.json must live under the scratch home.
    hooks="$(grep -o "[^'\" ]*hooks/soma/[^'\" ]*" "$H/.claude/settings.json" 2>/dev/null | sort -u)"
    foreign="$(printf '%s\n' "$hooks" | grep -v "^$H/" | grep -v '^$')"
    if [ -z "$hooks" ]; then echo "FAIL settings.json has no soma hook entries (uninstalled? reinstall before driving hooks)"; ok=1
    elif [ -n "$foreign" ]; then echo "FAIL settings.json hooks outside the scratch home:"; echo "$foreign"; ok=1
    else echo "ok   all $(printf '%s\n' "$hooks" | wc -l | tr -d ' ') soma hook path(s) in settings.json are under the scratch home"; fi
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
    sid="$(printf '%s' "$payload" | sed -n 's/.*"session_id" *: *"\([^"]*\)".*/\1/p')"
    [ -n "$sid" ] && echo "$sid" >>"$RUN/.hook-sessions"
    mkdir -p "$EV"; echo "# payload: $payload" >>"$EV/transcript.log"
    printf '%s' "$payload" | record iso bun "$hookjs" "$event"
    ;;
  real-home-check)
    [ -f "$RUN/.started" ] || die "no .started marker"
    ok=0
    # 1. Files outside memory/STATE: nothing else writes there during a run.
    # Covers every surface the claude-code projection writes: rules, hook
    # scripts, settings, and skill symlinks (-type l, not followed).
    changed="$(find "$HOME/.soma" "$HOME/.claude/rules/soma" "$HOME/.claude/hooks/soma" "$HOME/.claude/skills" "$HOME/.claude/settings.json" \
      -newer "$RUN/.started" \( -type f -o -type l \) -not -path '*/memory/STATE/*' -not -path '*/.git/*' 2>/dev/null)"
    if [ -z "$changed" ]; then echo "ok   no principal-home file outside memory/STATE changed since launch"
    else echo "CHECK files changed since launch (may be the live session; inspect before blaming the run):"; echo "$changed"; ok=1; fi
    # 2. memory/STATE: the live session writes there too, so attribute new
    # events instead of diffing mtimes. A new line naming this run dir or a
    # session id this run sent through `hook` is a leak.
    base="$(cat "$RUN/.real-events-lines" 2>/dev/null || echo 0)"
    if [ -f "$REAL_EVENTS" ]; then
      new="$(tail -n +"$((base + 1))" "$REAL_EVENTS")"
      n="$(printf '%s' "$new" | grep -c . || true)"
      leak="$(printf '%s\n' "$new" | grep -F "$RUN" || true)"
      if [ -f "$RUN/.hook-sessions" ]; then
        leak="$leak$(printf '%s\n' "$new" | grep -F -f "$RUN/.hook-sessions" || true)"
      fi
      if [ -n "$leak" ]; then echo "FAIL events from this run landed in $REAL_EVENTS:"; echo "$leak"; ok=1
      else echo "ok   $n new event(s) in the principal's events.jsonl, none naming this run dir or its hook session ids"
        [ "$n" -gt 0 ] && echo "note other memory/STATE files are not attributed; the live session writes there"; fi
    else echo "ok   principal has no events.jsonl"; fi
    exit $ok
    ;;
  cleanup)
    [ -f "$RUN/.started" ] || die "refusing: $RUN was not created by launch"
    rm -rf "$H" "$RUN/.started" "$RUN/.real-events-lines" "$RUN/.hook-sessions"
    [ -d "$EV" ] && echo "cleaned $H; evidence kept at $EV" || echo "cleaned $H; no evidence dir"
    ;;
  *) die "unknown command: $CMD" ;;
esac
