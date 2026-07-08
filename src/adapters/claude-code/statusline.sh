#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Soma status line — one compact line, fast (bash+jq+git, no network, no bun).
# Layout:  ⚙E2 slug·phase · model · dir ⎇branch● · ctx 38% · 5h 12%⟳2h14 · 7d 41%⟳3d1h
# Reads Claude Code's stdin JSON + Soma STATE files. Every segment is optional:
# a missing field simply drops its segment; the line never errors.
# ─────────────────────────────────────────────────────────────────────────────
set -o pipefail

SOMA_HOME="${SOMA_HOME:-__SOMA_HOME__}"
STATE_DIR="$SOMA_HOME/memory/STATE"

# ── colors (subtle) ──────────────────────────────────────────────────────────
if [ -t 1 ] || true; then
  DIM=$'\e[38;5;244m'; SEP=$'\e[38;5;240m'; RESET=$'\e[0m'
  SOMA=$'\e[38;5;39m'           # Soma blue
  DIR=$'\e[1;38;5;252m'; BR=$'\e[38;5;108m'
  OK=$'\e[38;5;108m'; WARN=$'\e[38;5;179m'; HOT=$'\e[38;5;174m'
fi
sep() { printf '%s · %s' "$SEP" "$RESET"; }

# ── read stdin JSON once ─────────────────────────────────────────────────────
input=$(cat)
eval "$(printf '%s' "$input" | jq -r '
  "cwd=" + (.workspace.current_dir // .cwd // "." | @sh) + "\n" +
  "sid=" + (.session_id // "" | @sh) + "\n" +
  "model=" + (.model.display_name // "" | @sh) + "\n" +
  "ctx=" + (.context_window.used_percentage // 0 | floor | tostring) + "\n" +
  "r5=" + (.rate_limits.five_hour.used_percentage // "" | tostring) + "\n" +
  "r5r=" + (.rate_limits.five_hour.resets_at // "" | @sh) + "\n" +
  "r7=" + (.rate_limits.seven_day.used_percentage // "" | tostring) + "\n" +
  "r7r=" + (.rate_limits.seven_day.resets_at // "" | @sh)
' 2>/dev/null)"

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
  local p=${1%%.*}; [ -z "$p" ] && { printf '%s' "$DIM"; return; }
  if   [ "$p" -ge 80 ]; then printf '%s' "$HOT"
  elif [ "$p" -ge 50 ]; then printf '%s' "$WARN"
  else printf '%s' "$OK"; fi
}

out=""

# ── 1. Soma segment (active VSA/run for THIS session) ────────────────────────
if [ -n "$sid" ]; then
  cw=$(ls -t "$STATE_DIR"/current-work-"$sid"-*.json 2>/dev/null | head -1)
  if [ -n "$cw" ]; then
    read -r phase task status < <(jq -r '[.phase // "", .task // .slug // "", .status // ""] | @tsv' "$cw" 2>/dev/null | tr '\t' ' ')
    task="${task:0:22}"
    if [ "$phase" = "native" ] || [ "$status" = "complete" ]; then
      [ -n "$task" ] && out+="${SOMA}○ ${task}${RESET}"
    elif [ -n "$phase" ]; then
      eff=$(jq -r '.effort // ""' "$STATE_DIR/active-algorithm-run.json" 2>/dev/null)
      out+="${SOMA}⚙${eff}${RESET} ${SOMA}${task}${DIM}·${phase}${RESET}"
    fi
  fi
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
  sb=$(git -C "$cwd" --no-optional-locks status -sb --porcelain 2>/dev/null)
  head=$(printf '%s\n' "$sb" | head -1)
  branch=$(printf '%s' "$head" | sed -E 's/^## ([^ .]+).*/\1/')
  dirty=$(printf '%s\n' "$sb" | tail -n +2 | grep -c .)
  ahead=$(printf '%s' "$head" | grep -oE 'ahead ([0-9]+)' | grep -oE '[0-9]+')
  behind=$(printf '%s' "$head" | grep -oE 'behind ([0-9]+)' | grep -oE '[0-9]+')
  [ -n "$branch" ] && gitseg+=" ${DIM}⎇${RESET}${BR}${branch}${RESET}"
  [ "${dirty:-0}" -gt 0 ] && gitseg+="${HOT}●${RESET}"
  [ -n "$ahead" ] && gitseg+="${DIM}↑${ahead}${RESET}"
  [ -n "$behind" ] && gitseg+="${DIM}↓${behind}${RESET}"
fi
[ -n "$out" ] && out+="$(sep)"; out+="$gitseg"

# ── 4. context % ─────────────────────────────────────────────────────────────
out+="$(sep)${DIM}ctx ${RESET}$(pct_color "$ctx")${ctx}%${RESET}"

# ── 5. 5h window ─────────────────────────────────────────────────────────────
if [ -n "$r5" ] && [ "$r5" != "null" ]; then
  rr=$(until_str "$r5r")
  out+="$(sep)${DIM}5h ${RESET}$(pct_color "$r5")${r5%%.*}%${RESET}"
  [ -n "$rr" ] && out+="${DIM}⟳${rr}${RESET}"
fi

# ── 6. 7d window ─────────────────────────────────────────────────────────────
if [ -n "$r7" ] && [ "$r7" != "null" ]; then
  rr=$(until_str "$r7r")
  out+="$(sep)${DIM}7d ${RESET}$(pct_color "$r7")${r7%%.*}%${RESET}"
  [ -n "$rr" ] && out+="${DIM}⟳${rr}${RESET}"
fi

printf '%s' "$out"
