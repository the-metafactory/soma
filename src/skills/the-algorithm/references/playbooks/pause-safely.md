# Playbook: Pause safely

**Task shape:** the principal asks you to stop, or the context is about to run out. Only on an explicit stop; "keep going" never pauses.
**You own:** a clean stop that a cold-start session can resume from.

## Steps

1. Stop at a safe boundary: finish the current atomic step or back out of it. Start nothing new.
2. Cancel any delegated work still running, or record where it will land.
3. Take no irreversible action to pause: no new push, PR or deploy.
4. Make the work durable: commit uncommitted edits as one clear `wip:` commit on the current branch. If the tree is broken, say so in the commit body.
5. Record the state in the Algorithm run: progress, what is verified, the next step, key files, gotchas.
6. Write the first action on resume as one line a cold-start session can execute.

## Criteria

- C1: The working tree is clean or holds only a named `wip:` commit (probe: `git status`).
- C2: The run records the next step (probe: `algorithm show`).
- Anti: Nothing was pushed, published or deployed to pause (probe: the remote and the tracker).

## Principles

`references/principles/ask-before-irreversible.md`, `references/principles/verify-before-claiming.md`.

**Reply:** where you are, what is on disk versus not, the commit you made and whether the tree is clean, and the first action on resume. This is a pause, not a final report.
