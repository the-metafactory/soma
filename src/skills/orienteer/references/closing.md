# Closing a node

A node closes only through its attached checkpoint's completion gate, and
`soma graph close` refuses a **hollow close**: no attached checkpoint, a
declared probe that never ran, a probe that ran and failed, or no
agent-external evidence entry carrying a pointer someone else can check. When it
refuses, no close is written.

One write happens before any of that: `--propose` posts its comment (below). It
checks that the node *has* a checkpoint first, so it cannot publish a proposal
that can never be acted on — but the probes have not run at that point, so a
proposal can still be posted for a close that later fails on its probes.

## Attach the checkpoint at creation

Pass `--checkpoint <id>` to `soma graph add`. There is **no verb that attaches
one later**, so a node created without it can only be repaired by hand-editing
its node block on the tracker — and it cannot close until you do.

Pick an id that does not embed the node's own number: the number does not exist
until after the create call returns.

## Declare probes up front, and declare them so they can run

Evidence is typed by whether it was *specified* before the work and then
*actually probed*. Self-declared verification is hollow; that split is the whole
point. A probe is a machine-checkable expectation, never prose:

```json
{"type": "command", "run": "bun test", "timeoutSec": 900, "expectExit": 0}
{"type": "url", "target": "https://status.example.com/health", "expectStatus": 200}
{"type": "git-ref-exists", "ref": "main"}
{"type": "git-merged-into", "ref": "feat/x", "into": "main"}
{"type": "artifact-exists", "path": "src/thing.ts", "atRef": "main"}
```

Timeout expiry is **failure**, never a pass and never a hang. A probe that could
not run at all is a **failed** probe, never a skipped one.

### The probe registry

`command` and `url` probes run only if the closing machine's registry authorises
them — probe declarations are tracker content, and tracker content may
parameterise a probe but never introduce executable code or a network
destination. The registry lives in soma-home
(`~/.soma/policy/probe-registry.json`), scoped by repo identity; read it with:

```bash
soma policy probes [--repo <owner/name>]
```

- `command` — refused unless the exact `run` string **and** the resolved
  absolute `cwd` are declared.
- `url` — refused unless the target host is declared; non-http(s) targets are
  refused outright.
- `git-ref-exists`, `git-merged-into`, `artifact-exists` — ungated.

A refused probe is a failed probe, so the close refuses and names the exact
entry to declare. There is deliberately no verb that adds one: widening the
registry is the adopter's act, not the agent's.

Practical consequence when charting: prefer probes the adopter has already
authorised, and expect a close on a fresh machine to refuse until it declares
them. Reading is unaffected — `soma graph node` and `soma graph frontier` read
any node regardless, because a node is data.

## AFK close (`auto`)

Close directly. The verb runs the probes and derives the evidence from them;
`--evidence` may add entries but never substitutes for a passed probe.

```bash
soma graph close <id> --dry-run   # preview the verdict and receipt, write nothing
soma graph close <id>
```

The receipt proves *existence and probe passage, not quality* — sound because
`auto` work sits below the irreversibility line. Quality ratifies when a
downstream HITL node consumes the artifact.

## HITL close (`propose` / `approve`)

Two phases, one verb:

```bash
soma graph close <id> --propose --body-file <path>   # posts the proposal, closes nothing
#  … the principal reacts 👍 on that comment …
soma graph close <id> --proposal-comment <comment-id>
```

The receipt is the ratification, read from the API's author field — never from
body text. A 👎 from the graph root's author suppresses ratification outright.

Two things the runtime does **not** do here, both of which are yours to hold:

- **Any non-proposer's 👍 closes the node.** The ratifier is preferred to be the
  graph root's author, but the fallback is the first other reaction — so on a
  public tracker a stranger's thumb produces `approved` evidence and the node
  closes. Only the `attestation` label records that it was not the right human.
  Read root-author approval as the *thing you must obtain*, not as a condition
  the verb enforces.
- **Ratification binds to a comment id, not to its text.** Nothing hashes the
  proposal body, so a proposal that is ratified and *then edited* still closes
  on that 👍. "A materially amended proposal is re-posted and needs fresh
  ratification" is doctrine you follow, not a property the runtime checks: if
  the resolution changes materially, post a new comment and get a new 👍.

## Attestation

`attestation` is **derived** at close time from the deployment's actual shape —
never configured, and there is no flag that turns it on. It is a **label, not a
gate**: the close proceeds either way, because gating on it would deadlock a
bootstrap in which the nodes that establish credential separation are themselves
`approve`-class.

`unverified` is the honest default wherever the session can still reach the
ratifying credential. Read it as visible state, not as a failure, and never
paper over it — a degraded receipt that looks verified is the one outcome this
whole construction exists to prevent. The receipt records the *facts* — proposal
and ratifier ids and authors, root node and author, backend capability, the
confinement check — so a later reader can tell a wrong ratifier from a reachable
keyring, which have different fixes.

## Recording the resolution

1. Post the answer as a **resolution comment** on the node — the human-readable
   half; the close receipt is the machine-readable half.
2. Close it with `soma graph close`.
3. Append a one-line gist plus link to the map's **Decisions so far**.
4. Graduate any fog the answer sharpened (`references/fog.md`), clearing each
   graduated patch from **Not yet specified** so it lives only as its new node.
