# Tana tuple sample

`tuple-sample.json` is a minimized, anonymized capture of two tuple/field-value
pairs from a real supertag SQLite index, read with SQLite `mode=ro` on
2026-10-21. It bypasses the test's `addFieldValues` helper.

The tuples were selected independently: one with a nonempty `field_def_id`,
one with an empty `field_def_id`, each with exactly two children and its
`value_node_id` equal to the second child. Before anonymizing, each pair was
checked to have `raw_data.props._docType == "tuple"` and
`(raw_data.props._sourceId or "") == field_def_id`.

All IDs were replaced consistently within each pair. Both parent IDs were
replaced with `sample-item` to assemble a synthetic collection item. The
`private-status` and `private-sphere` roles and option IDs are synthetic;
they do not retain the original fields' meaning. Only `id`, `children`,
`props._docType` and (when present) `props._sourceId` were retained from
`raw_data`. Names, values as text, owners, timestamps and other properties
were omitted. The indexed `node_type` and `value_order` were retained.

The independent upstream contract is supertag-cli commit
`3deda461cde1762ba6e517759d282edccff2918e`:

- [`resolveFieldNameFromTuple`](https://github.com/jcfischer/supertag-cli/blob/3deda461cde1762ba6e517759d282edccff2918e/src/db/field-values.ts#L143-L178)
  resolves the field label through `tuple.children[0]`.
- [`extractFieldValuesFromNodes`](https://github.com/jcfischer/supertag-cli/blob/3deda461cde1762ba6e517759d282edccff2918e/src/db/field-values.ts#L332-L385)
  uses `node.props._sourceId || ""` for `fieldDefId`, the tuple node ID for
  `tupleId`, and each remaining child's ID for `valueNodeId`.

A read-only aggregate probe of that index found 467,826 `field_values` rows,
zero missing tuple nodes, and a text first child for all 467,826 rows:

```sql
SELECT COUNT(*) AS total,
       SUM(t.id IS NULL) AS missing_tuple,
       SUM(json_type(t.raw_data, '$.children[0]') = 'text') AS first_child_is_text
FROM field_values v LEFT JOIN nodes t ON t.id = v.tuple_id;
```

This probe describes the captured index, not a guarantee about future index
versions. The replay test pins the observed shape; the reader separately
fails closed for missing or malformed tuple data and ignores other attributes,
as node #1031 requires.
