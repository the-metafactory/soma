# Arc Install Troubleshooting

Install Soma from its GitHub repository:

```bash
arc install https://github.com/the-metafactory/soma
```

## `arc upgrade soma` does not find a new release

`arc upgrade soma --check` consults the Arc registry. A release published only
on GitHub does not update the registry, so the check reports no upgrade. Force
the upgrade instead. Arc pulls the checkout and runs
`bun install --frozen-lockfile`:

```bash
arc upgrade soma --force
```

## `soma --version` still shows the old version

The `soma` launcher runs a frozen runtime artifact under
`~/.soma/runtime/<target>/current`, not the Arc checkout. Activate the new
artifact by reprojecting each substrate you use:

```bash
soma install claude-code --apply
soma install codex --apply
soma install pi-dev --apply
```

Then check that every target runs the same artifact hash:

```bash
soma runtime status --target cli
soma runtime status --target claude-code
soma doctor
```

## An upgrade refuses to replace the active install

If Arc refuses to replace an older active install, remove it and install
again. To pin a specific release, pass its tag:

```bash
arc remove soma
arc install https://github.com/the-metafactory/soma --pin v0.29.3
```

This removes Arc's package registration and symlinks before installing the
release. Your Soma home and assistant memory are not stored inside the Arc
package checkout, so removing the package does not delete the assistant
state. Reproject the substrates you use afterwards, as above.
