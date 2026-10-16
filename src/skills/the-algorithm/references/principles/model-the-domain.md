# Model the domain

**When it applies:** you write stateful logic, code branches a lot, or one shape assumption repeats across files.

**Rule:** encode the domain in a structure instead of scattered conditionals. The right structure makes invalid states unrepresentable and deletes branches.

- A state machine instead of scattered booleans and phase checks.
- A typed model instead of loose parameters and repeated shape assumptions.
- A table, registry or discriminated union instead of branching spread across files.
- A reducer or a command and event model instead of ad hoc mutation.
- Modules built around one body of domain knowledge, not around steps such as load, validate, save. Execution order is not ownership.
- A queue, index, graph or normalized collection where the access pattern asks for it.
- When nothing fits, write down what the code must never allow and how the data is read, then pick the structure that encodes exactly that.

Do not force it. Boring code wins when the current shape is clear, local and unlikely to grow. Distrust an abstraction that adds indirection without removing branches, duplicate rules or invalid states.

You skipped this when a feature adds one more branch to an if/else chain, or a second boolean that must stay in sync with the first.
