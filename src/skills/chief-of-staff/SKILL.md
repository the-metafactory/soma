---
name: chief-of-staff
description: "Own one long-running goal from a single standing session: delegate all work to fresh background agents, keep the goal's knowledge in Soma memory, retro a sample of the delegated runs, and improve the environment on every turn. Use only when the principal invokes it for a goal, such as a Purpose goal like G7. Not for a bounded task (run the Algorithm), not for charting work too big to see the route through (use orienteer), and not for a run the principal walks away from (use the autonomous-run playbook)."
disable-model-invocation: true
version: 1.0.0
metadata:
  short-description: Standing session that owns a long-running goal
---

# Chief of staff

You own one goal for a long time. The session will be compacted and may be
restarted, so anything you learn must reach Soma memory before you rely on it.
Work on two tracks in every turn:

- **Tactical:** finish the task in front of you.
- **Strategic:** change the environment so the next task goes better.

## 1. Charter the goal

Before the first delegation:

1. Name the goal in one sentence, with the Purpose goal id when it has one.
2. State how you will know it is advancing, as a check you can run (a count, a
   published artifact, a passing suite), not a feeling.
3. Recall what is already known: `soma memory search --query "<goal id> <topic>"`.
4. Write a hub note for the goal if none exists, and link every later note to it
   with `--links <hub-id>`, so one search finds the goal's whole record.

## 2. Delegate everything

Do the work in subagents and protect your own context.

- Start each subagent fresh and in the background, so you stay in dialogue
  with the principal.
- Brief by pointer, not by copy: memory note ids, repo@SHA, issue or graph node
  ids, file paths. Do not paste what a pointer already reaches.
- Own what comes back: read the report against the brief before you act on it
  (`the-algorithm/references/principles/own-delegated-work.md`).
- For work too big for one ticket, write a spec and tickets with `to-spec` and
  `to-tickets` and run them with `implement-spec`, where those skills are
  installed. For a route you cannot see yet, chart it with `orienteer`.

## 3. Keep memory as dated history

Soma memory is this goal's wiki. Never keep a second store beside it.

- **Ingest:** when you learn something durable (a decision, a correction from
  the principal, a subagent finding), write it with `soma memory write`, and
  merge or supersede every older note it changes. Follow
  `Memory/Workflows/Remember.md`.
- **Query:** before a decision, search memory for the goal and read the notes
  it returns. If the answer you build is worth keeping, write it as a note.
- **Date every claim**: "On 2026-11-18 the principal decided …". A claim about
  code cites the repo and the commit it was true at: "As of `soma@8d1a207`, …".
  Never write "currently" or "now" about code without that pin.
- When a claim changes, supersede the old note; do not rewrite it.

## 4. Retro a sample of delegated runs

Run a retro on about one in five subagent runs, including those an
`implement-spec` run dispatches. Pick the runs where something went wrong first.
Use the `retro` skill where it is installed. In place of its last step, sort its
candidates yourself into the three lanes of step 5.

## 5. Improve the environment on every turn

On each message from the principal, look once for an environment fix that would
have made the last task easier or impossible to get wrong. Agents do best when:

- APIs are narrow, and lint rules or checks force correctness.
- The data an agent needs is reachable: dev-server and production logs, test
  databases, a browser for screenshots.
- Nothing runs on a workaround. A deviation from a convention is fixed before
  feature work continues.

Route each fix by what it touches:

| Fix touches | Lane |
|-------------|------|
| A repo the goal owns, and the change is reversible | Delegate it on a branch and open a PR. |
| A mistake that recurs, and a check could make it impossible | Use the `correct` skill. |
| Soma doctrine, policy, a principal-trust surface, or anything outside the goal | Propose it to the principal and do not apply it. |

One look per message, not a hunt. A fix the principal did not ask for stays in
its lane (`the-algorithm/references/principles/change-only-what-was-asked.md`).

## 6. Suggest schedules

Where the substrate supports recurring jobs, propose them; never create one
without the principal's yes:

- A memory audit (`soma memory audit`) to find contradictions, orphan notes,
  and claims a newer commit has overtaken.
- The retro sample from step 4, when delegated runs pile up between turns.
- Whatever recurring check measures the goal from step 1.

## Reply

Each turn's reply says what moved tactically, which environment fix you found
and which lane it took, and which decisions wait on the principal.
