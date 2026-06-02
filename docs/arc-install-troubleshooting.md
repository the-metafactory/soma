# Arc Install Troubleshooting

## `arc upgrade soma` reports an older active install

Some Arc registry installs cannot be upgraded in place when an older extracted
package is already active. In that case Arc may resolve the newer
`@metafactory/soma` version correctly, then refuse the install because the old
`soma` package is still active.

Use Arc's remove-then-install recovery path:

```bash
arc remove soma
arc install @metafactory/soma
```

To pin a specific release:

```bash
arc remove soma
arc install @metafactory/soma@0.8.2
```

This removes Arc's package registration and symlinks before installing the
new registry version. Your Soma home and assistant memory are not stored inside
the Arc package checkout, so normal package removal should not delete the
assistant state.

After reinstalling, refresh the substrate projections you use:

```bash
soma install codex --apply
soma install pi-dev --apply
soma install claude-code --apply
```

If Arc later supports transparent in-place upgrades for extracted registry
packages, this workaround can be removed from the docs.
