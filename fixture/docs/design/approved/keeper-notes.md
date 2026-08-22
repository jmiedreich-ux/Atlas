# Keeper's notes

Fixture content only, invented for Atlas's own test suite (decision 40). Stands in for a second,
differently-styled authority document under `docs/design/` — this one numbers entries as headings
rather than the bold-paragraph style of `lighthouse-decisions.md`, because the real corpus is not
uniform and Atlas has to render both (decision 11).

## Notes

The real corpus nests lists at two- and three-space indentation, never four, so both are exercised
here.

- Beacon's watch rotation
  - Dawn shift
  - Dusk shift
- Tide's gauge readings
  - Low water
  - High water

1. Confirm the lamp is lit
   1. Check the oil reservoir
   2. Check the mechanism
2. Log the reading

## D15

The reading log is a table, and the corpus cites its sources with `<sub>` tags:

| Reading | Value | Source |
| --- | --- | --- |
| Oil level | 82% | <sub>keeper's log, watch 14</sub> |
| Lamp bearing | 214°<sub>true</sub> | field notes |

See the [watch rotation plan](../../features/beacon/m2-plan.md) for how the schedule is built, the
[fixture repository](https://github.com/atlas-fixtures/lighthouse) for where this all lives, and the
[keeper's field notes](../../field%20notes.html) for the original scan of this log — a standalone
page copied byte-for-byte (decision 10), including the space in its filename.

```json
{ "codename": "Beacon", "stage": "shipping" }
```

## Notes

A second section titled the same as the first, so a rebuild gives it a distinct, stable id rather
than colliding with the one above.
