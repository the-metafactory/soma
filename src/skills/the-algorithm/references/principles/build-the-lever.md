# Build the lever

**When it applies:** any non-trivial work: edits, migrations, analyses, checks. The bar is triviality, not repetition.

**Rule:** build the tool that does or proves the work (a codemod, a script, a generator, a rerunnable check) instead of doing it by hand. A reviewer can rerun the tool; hand work can only be re-verified by redoing it.

- Do the first unit by hand to learn the recipe, then build the tool. Prove it by rerunning it on that unit and diffing against your hand result. Keep it safe to rerun.
- A deterministic tool beats fan-out. If one pass covers every unit, run it yourself instead of spreading hand edits across helpers.
- When work does fan out to subagents, write the recipe, the verification contract and the do-not-touch fences into one file they all read, kept outside their write scope.
- Build the smallest script that does the job, never a framework (`references/principles/laziness-protocol.md`).
- Commit the tool when the work outlives the session.

You skipped this when you cite this principle and the diff holds no script, codemod, generator or shared recipe.

Distinct from `references/principles/encode-lessons-in-structure.md`, which turns a recurring lesson into a guardrail. This makes the work in front of you checkable.
