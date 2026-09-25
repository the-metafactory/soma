# GitLab work graphs

Soma can store a work graph in GitLab work items. A map root is a group **Epic**;
route nodes are **Issues** and their scaffolds are **Tasks**. The Epic names one
`home` project under its group. Soma creates new nodes in that project and uses
GitLab hierarchy and blocking links as the graph. GitLab remains the sole
authority for node state; Soma keeps no synchronized copy.

The backend and CLI are covered by fake-transport tests. **A complete walk has
not yet been exercised against a live GitLab server**, including Task-floor
re-home and close receipts. Use a scratch project for the first live walk and
verify each returned work item before relying on it for production work.

## Before charting a map

- Install Soma and `glab`, then authenticate `glab` for the intended host.
  Check with `glab auth status --hostname gitlab.example.com`.
- Use a GitLab host and group with the Epic, Issue, Task, hierarchy, and related
  work-item features enabled. The account needs permission to create and edit
  those work items in the group and home project.
- Choose an existing home project **beneath the Epic's group**. In the examples,
  `acme/work` is the home project and `acme` is the Epic group.
- Run the installed `soma` CLI for close operations. A source-tree invocation
  warns that the close gate is running from the tree it guards.

`--repo` and `SOMA_GRAPH_REPO` accept a qualified location such as
`gitlab:gitlab.example.com/acme/work`. A bare path uses the checkout's origin
remote to resolve its host; outside a suitable checkout, use the qualified form.
The forge and host in a qualified node ref select the backend directly. GitHub
remains available as `github:github.com/owner/repo`; GitHub Enterprise hosts
are not supported by this backend binding.

## Chart and walk

```bash
soma graph chart --repo gitlab:gitlab.example.com/acme/work \
  --home-project acme/work --title "Service roadmap" \
  --autonomy approve --checkpoint cp-roadmap --json
```

`chart` returns a group Epic id such as `acme&17`. Its typed node block carries
`home: acme/work`. The `--repo` project and `--home-project` must agree, and the
home project must sit under the Epic group. A missing or malformed typed home
refuses at creation; a mismatch between typed home and a valid legacy route
comment refuses on read. An invalid legacy route comment is ignored when the
typed home is valid. Existing Epics with a valid legacy route comment still read.
Keep the returned id: GitLab issue numbers repeat across projects, so a node
needs its path as well as its number. Quote Epic refs in a shell because `&`
has shell meaning.

```bash
soma graph node 'gitlab:gitlab.example.com/acme&17'
soma graph frontier 'gitlab:gitlab.example.com/acme&17'
soma graph add 'gitlab:gitlab.example.com/acme&17' \
  --title "Choose the next route" --autonomy approve --checkpoint cp-route
```

Adding under the Epic creates an Issue in `acme/work`. The returned id has a
project path, for example `acme/work#42`. Adding under that Issue creates a
Task in the same project:

```bash
soma graph add 'gitlab:gitlab.example.com/acme/work#42' \
  --title "Build a small probe" --autonomy approve --checkpoint cp-probe
soma graph claim 'gitlab:gitlab.example.com/acme/work#42'
```

An Epic is for orchestration and cannot be claimed. `add` requires a
checkpoint because no verb attaches one later. GitLab creation currently
refuses `--label`; use the Epic and qualified refs to navigate. Adding beneath
a Task requests a new Task under its nearest Issue ancestor with a related
link back to the requested Task; that path has not been live verified.

## Close and inspect

Write the resolution in a local file, then check the close without writing:

```bash
soma graph close 'gitlab:gitlab.example.com/acme/work#42' \
  --resolution-file ./route-resolution.md --dry-run
soma graph close 'gitlab:gitlab.example.com/acme/work#42' \
  --resolution-file ./route-resolution.md --gist "Route chosen and recorded"
soma graph audit 'gitlab:gitlab.example.com/acme&17'
soma graph decisions 'gitlab:gitlab.example.com/acme&17'
```

A close posts a receipt to GitLab and records the checkpoint, resolution,
evidence, and attestation. GitLab command probes are authorized by the registry
entry for the node's own location: the Epic uses its group key
`gitlab.example.com/acme`, while Issues and Tasks in the home project use
`gitlab.example.com/acme/work`. `soma policy probes` shows the read-only
registry. `auto` nodes require declared
probes and a `--ci <checkRunId>@<headSha>` citation, but the GitLab backend does
not independently verify that CI run's result. Do not rely on `auto` closure as
an independently verified gate on GitLab yet. A `propose` or `approve` node may
close without a ratifying reaction; the receipt then reports
`attestation: unverified`. A verified attestation
requires a separate ratifier and credential isolation, as described in
[the work-graph contract](work-graph.md#deriving-attestation-502).

If a write fails after creating a child but before linking its blocker, the
child remains in GitLab and the CLI names it for repair. Inspect the returned
item and run `audit` before continuing. Do not assume an error rolled back a
tracker write.
