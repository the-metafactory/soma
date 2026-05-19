# Soma Relationship Reflection Contracts

Relationship reflection reads and writes through the Soma path resolver. It
does not call notification services directly; callers can inject a notifier.

## Relationship Notes

Daily relationship notes live under the Soma relationship memory root in
`YYYY-MM/YYYY-MM-DD.md` files.

Each parseable line uses this shape:

```text
W: <entity> — <positive observation>
B: <entity> — <negative observation>
O: <entity> — <neutral observation>
```

`W` and `O` lines become supporting evidence for the entity opinion. `B` lines
become counter evidence. Missing opinions are created in the relationship
category before evidence is appended.

## Milestones

Default milestones:

- `first-pushback`: pushed back, disagreed, or challenged
- `genuine-unknown`: do not know, not sure, or uncertain
- `voice-smile`: voice, smiled, or laughed
- `100-sessions`: at least 100 non-empty ratings entries

Milestones append to `identity/our-story.md` with hidden milestone IDs to avoid
duplicates.

## Notification

Confidence shifts greater than `0.15` can notify through an injected
`RelationshipNotifier`. The CLI default is silent.
