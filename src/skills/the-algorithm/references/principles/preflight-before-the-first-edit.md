# Preflight before the first edit

**When it applies:** OBSERVE, before work starts. Fire every gate whose trigger matches; a false positive is cheap, a false negative fails mid-EXECUTE.

**Rule:** confirm the conditions the work depends on before you depend on them.

| Gate | Trigger | Check |
| --- | --- | --- |
| A: Diagnostic | a bug fix, "X broken", debugging | the system is observable; reproduce the failure before reading code (`references/principles/reproduce-first.md`) |
| B: Deploy, API | deploy, API, infrastructure | every credential, CLI tool and service access the work needs exists |
| C: External service | Cloudflare, Stripe, Telegram, any external API | the relevant skill is loaded and its documented gotchas are read |
| D: Research | errors, API failures, unfamiliar library behavior | external docs are searched before local code archaeology |

- Record each fired gate as one line: the gate and its finding.

You skipped this when a missing credential, tool or doc surfaced after the first edit.
