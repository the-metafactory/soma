#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Soma status line — one compact line, fast (bash+jq+git, no network, no bun).
# Layout:  ⚙E3 task · model · dir ⎇branch● · ctx 38% · 5h 12%⟳2h14 · 7d 41%⟳3d1h
# Reads Claude Code's stdin JSON + Soma STATE files. Soma state, git, and the
# usage windows drop when their data is absent; dir and context always render
# with sane defaults. Best-effort: missing or malformed data degrades the
# affected segment rather than breaking the line.
# ─────────────────────────────────────────────────────────────────────────────
set -o pipefail

SOMA_HOME="${SOMA_HOME:-__SOMA_HOME__}"
STATE_DIR="$SOMA_HOME/memory/STATE"

# ── colors (subtle) ──────────────────────────────────────────────────────────
# Claude Code renders ANSI regardless of tty, so define unconditionally.
DIM=$'\e[38;5;244m'; SEP=$'\e[38;5;240m'; RESET=$'\e[0m'
SOMA=$'\e[38;5;39m'           # Soma blue
DIR=$'\e[1;38;5;252m'; BR=$'\e[38;5;108m'
OK=$'\e[38;5;108m'; WARN=$'\e[38;5;179m'; HOT=$'\e[38;5;174m'
sep() { printf '%s · %s' "$SEP" "$RESET"; }

# ── read stdin JSON once ─────────────────────────────────────────────────────
# NO eval: jq joins the fields with the ASCII unit separator (US, 0x1f) and one
# `read` splits them back. This is injection-proof (nothing is evaluated) AND
# handles empty fields: a whitespace IFS (e.g. tab) collapses adjacent
# separators, so an absent middle field (empty session_id, or missing rate
# limits early in a session) would shift every later field — US is
# non-whitespace, so `read` keeps one field per separator, empties included.
# Fields land as plain strings (ctx/r5/r7 like "38"; resets_at epoch strings,
# which until_str already handles). Portable to bash 3.2 (no mapfile -d).
input=$(cat)
US=$'\037'
IFS="$US" read -r cwd sid model ctx r5 r5r r7 r7r < <(printf '%s' "$input" | jq -j --arg sep "$US" '
  [ (.workspace.current_dir // .cwd // "."),
    (.session_id // ""),
    (.model.display_name // ""),
    (.context_window.used_percentage // 0 | floor | tostring),
    (.rate_limits.five_hour.used_percentage // "" | tostring),
    (.rate_limits.five_hour.resets_at // "" | tostring),
    (.rate_limits.seven_day.used_percentage // "" | tostring),
    (.rate_limits.seven_day.resets_at // "" | tostring)
  ] | join($sep)' 2>/dev/null)
cwd="${cwd:-.}"
ctx="${ctx:-0}"

# ── helpers ──────────────────────────────────────────────────────────────────
# resets_at → compact "time until" e.g. 3d1h / 2h14 / 12m / now.
# Claude Code sends resets_at as a Unix EPOCH; also accept ISO8601 as a fallback.
until_str() {
  local ts="$1" now target d
  [ -z "$ts" ] || [ "$ts" = "null" ] && return
  if [[ "$ts" =~ ^[0-9]+$ ]]; then
    target="$ts"; [ "${#ts}" -ge 13 ] && target=$((ts/1000))   # epoch (seconds, or ms)
  else
    target=$(date -j -u -f "%Y-%m-%dT%H:%M:%S" "${ts:0:19}" +%s 2>/dev/null \
          || date -u -d "${ts:0:19}Z" +%s 2>/dev/null) || return
  fi
  now=$(date +%s); d=$((target - now))
  [ "$d" -le 0 ] && { printf 'now'; return; }
  local days=$((d/86400)) hrs=$(((d%86400)/3600)) mins=$(((d%3600)/60))
  if   [ "$days" -gt 0 ]; then [ "$hrs" -gt 0 ] && printf '%dd%dh' "$days" "$hrs" || printf '%dd' "$days"
  elif [ "$hrs"  -gt 0 ]; then printf '%dh%02d' "$hrs" "$mins"
  else printf '%dm' "$mins"; fi
}
pct_color() { # $1=percent → color by severity
  local p=${1%%.*}
  [[ "$p" =~ ^[0-9]+$ ]] || { printf '%s' "$DIM"; return; }   # non-numeric → neutral, no arithmetic error
  if   [ "$p" -ge 80 ]; then printf '%s' "$HOT"
  elif [ "$p" -ge 50 ]; then printf '%s' "$WARN"
  else printf '%s' "$OK"; fi
}
# append_window LABEL PCT RESET_AT → append a rate-limit window segment when
# PCT is present (e.g. `5h 12%⟳2h14`). Shared by the 5h + 7d windows.
append_window() {
  local label="$1" pct="$2" reset="$3" rr
  # Drop the segment unless PCT is a real number — an absent or malformed value
  # renders nothing rather than garbage (keeps the window segment truly optional).
  [[ "$pct" =~ ^[0-9]+(\.[0-9]+)?$ ]] || return
  rr=$(until_str "$reset")
  out+="$(sep)${DIM}${label} ${RESET}$(pct_color "$pct")${pct%%.*}%${RESET}"
  [ -n "$rr" ] && out+="${DIM}⟳${rr}${RESET}"
}

out=""

# ── 1. Soma segment (mode+effort for THIS session, task from current-work) ──
# Mode/effort come from the mode-classifier hook's per-session feed: the hook
# writes `statusline-mode-<sid>.json` after it classifies each prompt — the
# authoritative, session-scoped classification (not the current-work `phase`,
# doesn't carry mode/effort, and not the global active-algorithm-run.json,
# which leaks across concurrent sessions). Task is still read from the newest
# current-work file. Both reads are session-scoped — no global reads, so a
# concurrent session's state can never leak into this line.
#
# Guard `$sid` to a safe token BEFORE it touches any path (the mode-state read
# and the current-work glob): a crafted id (`../…`, `/`) must not traverse out
# of STATE. An unsafe id fails the guard and the whole Soma segment is dropped
# (the writer sanitizes on its side, so the two stay in lockstep for safe ids).
if [ -n "$sid" ] && [[ "$sid" =~ ^[A-Za-z0-9._-]+$ ]]; then
  smode=""; seff=""
  modefile="$STATE_DIR/statusline-mode-$sid.json"
  # Only spawn jq when the per-session state file exists (it won't before the
  # first classifier write, or after cleanup) — keeps the hot path fork-free then.
  if [ -r "$modefile" ]; then
    IFS="$US" read -r smode seff < <(jq -j --arg sep "$US" '[(.mode // ""), (.effort // "")] | join($sep)' "$modefile" 2>/dev/null)
  fi

  task=""
  cw=$(ls -t "$STATE_DIR"/current-work-"$sid"-*.json 2>/dev/null | head -1)
  if [ -n "$cw" ]; then
    task=$(jq -r '.task // .slug // ""' "$cw" 2>/dev/null)
    task="${task:0:22}"
  fi

  if [ "$smode" = "algorithm" ]; then
    out+="${SOMA}⚙${seff}${RESET}"
    [ -n "$task" ] && out+=" ${SOMA}${task}${RESET}"
  elif [ "$smode" = "native" ]; then
    [ -n "$task" ] && out+="${SOMA}○ ${task}${RESET}"
  fi
  # "minimal", missing state file, or malformed JSON: drop the segment entirely.
fi

# ── 2. model ─────────────────────────────────────────────────────────────────
if [ -n "$model" ]; then
  m=$(printf '%s' "$model" | sed -E 's/Claude //; s/ \(1M[^)]*\)//; s/Sonnet/sonnet/; s/Opus/opus/; s/Haiku/haiku/; s/Fable/fable/; s/ //g')
  [ -n "$out" ] && out+="$(sep)"; out+="${DIM}${m}${RESET}"
fi

# ── 3. dir + git ─────────────────────────────────────────────────────────────
dir_name=$(basename "$cwd")
gitseg="${DIR}${dir_name}${RESET}"
if git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # tracked changes only — `-uno` keeps the statusline fast in large repos.
  sb=$(git -C "$cwd" --no-optional-locks status -sb -uno --porcelain 2>/dev/null)
  # Parse in-process (no head/tail/grep forks — this runs on every refresh).
  head=${sb%%$'\n'*}                       # first line: the `## branch...` header
  # Keep dots in the branch name (`release/v1.2`), stopping only at the
  # `...upstream` tracking marker or the ` [ahead/behind]` counts.
  branch="${head#\#\# }"; branch="${branch%%...*}"; branch="${branch%% *}"
  # Any line beyond the header means tracked changes exist (we only need the ● flag).
  if [ "$sb" != "$head" ]; then dirty=1; else dirty=0; fi
  ahead=""; behind=""
  [[ $head =~ ahead\ ([0-9]+) ]] && ahead=${BASH_REMATCH[1]}
  [[ $head =~ behind\ ([0-9]+) ]] && behind=${BASH_REMATCH[1]}
  [ -n "$branch" ] && gitseg+=" ${DIM}⎇${RESET}${BR}${branch}${RESET}"
  [ "${dirty:-0}" -gt 0 ] && gitseg+="${HOT}●${RESET}"
  [ -n "$ahead" ] && gitseg+="${DIM}↑${ahead}${RESET}"
  [ -n "$behind" ] && gitseg+="${DIM}↓${behind}${RESET}"
fi
[ -n "$out" ] && out+="$(sep)"; out+="$gitseg"

# ── 4. context % ─────────────────────────────────────────────────────────────
out+="$(sep)${DIM}ctx ${RESET}$(pct_color "$ctx")${ctx}%${RESET}"

# ── 5. rate-limit windows (5h + 7d) ──────────────────────────────────────────
append_window "5h" "$r5" "$r5r"
append_window "7d" "$r7" "$r7r"

printf '%s' "$out"
