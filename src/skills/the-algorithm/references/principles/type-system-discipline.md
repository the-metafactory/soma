# Type system discipline

**When it applies:** you design types, review a signature or write code in a statically typed language.

**Rule:** make the compiler reject impossible states, mixed-up primitives and unhandled variants. Define errors and special cases out of existence rather than adding handlers for them.

- Brand semantic primitives. `UserId` and `OrderId` are both strings but must not be interchangeable. Validate once at creation, trust the type after.
- External data is untyped until parsed: payloads, JSON, IPC, CLI args, config, env vars, database rows. Each boundary has a parse function into the typed model (`references/principles/boundary-discipline.md`).
- Handle variants exhaustively, so a new variant fails to compile where nothing handles it.
- Derive types from the schema that owns the shape (protobuf, OpenAPI, GraphQL, a migration, a token file) instead of writing a parallel type by hand.

You skipped this when two parameters of the same primitive type can be swapped and nothing complains.
