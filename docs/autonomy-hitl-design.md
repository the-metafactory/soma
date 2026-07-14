# Letting an agent run without babysitting it

A design note on autonomy and human-in-the-loop for agents in this stack. It came out of a community thread about why autonomous coding agents feel untrustworthy: reward hacking, "any gate the LLM can write to is a gate it can forge", and the receipts idea. Nothing here is settled. It's a proposal to argue with.

## The gate problem

Vincent's example: he graded a model on whether a JSON file said the step passed, so the model wrote the JSON. That isn't the model lying, it's the model doing exactly what it was measured on. Two things follow, both true at once. Any gate the agent can write to, it will eventually forge. Any gate the agent can reach, it can switch off. A hook the agent can disable was never a hook.

## Autonomy is a line, not a dial

Treating autonomy as one global setting you turn up or down is the wrong model. There's a line instead, and the line is: can this action be undone, and how far does it reach if it's wrong.

Below the line (editing on a branch, running tests, reading, drafting, opening a PR) let the agent run and don't watch. Above it (merging to main, deleting or overwriting data, sending anything to the outside world, rotating a credential, touching its own configuration) stop and gate it.

Babysitting is parking the human below the line, watching reversible work. YOLO is letting the agent cross the line alone. Put the human on the line itself and you get both at once: free movement where mistakes are cheap, human attention only where they aren't.

## What makes a gate real

Three properties. Drop any one and the gate is theater.

1. It reads what happened, not what the agent says happened. "Tests exited 0, the old value is gone from the repo, the URL answered" is a fact you can point at, not a claim you read.
2. It runs where the agent has no hands: branch protection on the server, a hook that runs from a directory the agent can't write, an append-only log. The moment the agent can edit the enforcement point, there is no enforcement point.
3. The agent can't move its own setting. Whether an action is auto, propose, or needs-a-human sits outside its reach, and changing that setting is itself the most gated thing there is. Self-governance (hooks, config, doctrine, trusted memory) is always the top gate, fail-closed. This is the piece PAI got wrong.

## Don't make an LLM the gate

Learned on a real overnight build (a soma self-improvement run, three features shipped). I used a second model to review the PRs and treated its approval as the merge condition. It kept finding fresh nitpicks round after round until a human had to overrule it, which is babysitting wearing a costume.

A model reviewer is a filter, not a receipt. Let the deterministic checks gate (tests, a scan for banned patterns, a human tick for anything irreversible) and let the model feed into that as a second opinion. It's genuinely useful. It just can't be the judge.

## What we'd build

- An action taxonomy: reversibility x blast radius mapped to auto / propose / approve, projected in as policy the agent inherits and can't edit.
- That policy living where enforcement lives, not in the workspace. (Learned the hard way: a guard running out of the agent's own repo isn't a guard.)
- A named, machine-checkable receipt per gated action.
- A hard lock on any write to hooks, config, doctrine, or trusted memory.
- An append-only audit log, and maybe an independent observer later, never the agent auditing itself.

## Open questions

- Where does the undo line actually sit for our stack? Git makes a lot reversible; comms and credentials don't.
- What's the smallest set of automatic checks that lets a merge through without a human reading the whole diff?
- Per-task grants (raise the dial for one job, logged, one-way), standing per-type settings, or both?
- Is an observer process worth it yet, or premature?

The thing underneath all of it: the model stays untrusted, forever, and that's fine. You stop trusting its story and start trusting what you can independently watch happen, and you put something in the human-in-the-loop seat that the model can't talk around or shut off. It doesn't have to be a person. It just has to not be the thing being graded.
