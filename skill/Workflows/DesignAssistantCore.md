# Design Assistant Core

Use this workflow to design, revise, or evaluate Soma's portable assistant core.

## Steps

1. Identify which surface is being designed: identity, telos, ISA, memory, skill,
   policy, learning, or adapter.
2. State the substrate-neutral contract first.
3. Add substrate mappings only after the core contract is clear.
4. Keep deterministic storage and validation in code.
5. Keep substrate-specific behavior behind adapter boundaries.
6. Record decisions in `VSA.md`.

## Output

Return:

- contract changes
- affected adapters
- migration impact
- verification method

