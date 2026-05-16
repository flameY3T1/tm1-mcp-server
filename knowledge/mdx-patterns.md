# MDX Patterns for TM1

## Basic Query Shape

```mdx
SELECT
  { [Measures].[Sales], [Measures].[Quantity] } ON COLUMNS,
  { [Product].[All Products].Children } ON ROWS
FROM [SalesCube]
WHERE ( [Time].[2026], [Region].[Total Region] )
```

Axes: `COLUMNS` (axis 0), `ROWS` (axis 1), `PAGES` (axis 2). TM1 supports up to 64 axes but most clients display ≤2.

## Member References

```mdx
[Dimension].[Hierarchy].[Member]
[Dimension].[Hierarchy].[Member].[Child]
```

If a dimension has a single hierarchy, `[Dimension].[Member]` is shorthand. For alternate hierarchies, fully qualify: `[Region].[Geography].[EMEA]`.

## Set Functions

- `.Children` — direct children of a consolidated element
- `.Descendants(level)` — all descendants at or above a level
- `Filter( set, expression )` — boolean filter
- `Order( set, expression, BASC | BDESC )` — sort (B = break hierarchy)
- `TopCount( set, n, measure )` / `BottomCount( ... )` — top-N
- `Except( setA, setB )` — set difference
- `Crossjoin( setA, setB )` or `setA * setB` — cartesian product

## Common Patterns

### All leaf elements of a dimension

```mdx
{ TM1FILTERBYLEVEL( {TM1SUBSETALL( [Product] )}, 0 ) }
```

`TM1FILTERBYLEVEL(..., 0)` keeps only leaves. `TM1SUBSETALL` is faster than `Descendants` for the full set.

### Filter by attribute

```mdx
{ Filter( [Customer].Members, [Customer].CurrentMember.Properties("Region") = "EMEA" ) }
```

### Top 10 by sales

```mdx
{ TopCount( [Product].[All Products].Children, 10, [Measures].[Sales] ) }
```

### Non-empty rows

```mdx
NON EMPTY { [Product].Members } ON ROWS
```

Or `NonEmptyCrossjoin( setA, setB, n )` to keep tuples with at least n non-null measures.

## Calculated Members (Inline)

```mdx
WITH MEMBER [Measures].[Avg Sales] AS
  '[Measures].[Sales] / [Measures].[Count]'
SELECT { [Measures].[Avg Sales] } ON COLUMNS FROM [SalesCube]
```

Persisted calculated members live in `}DimensionFormulas` or via `tm1_set_cube_rules` — inline `WITH` is per-query only.

## Drilldown / Drillthrough

Drilldown to children:
```mdx
DrillDownMember( { [Product].[All Products] }, { [Product].[All Products] } )
```

Drillthrough (return source rows for a cell) is configured per-cube via `}DrillAssignments` — MDX expresses target, TI defines source.

## Performance Tips

- Put the largest dimension on the ROWS axis last (TM1 evaluates axes left-to-right)
- Use `NON EMPTY` aggressively — TM1 short-circuits empty rows
- Prefer `TM1FILTERBYLEVEL` over `Filter(... .Level = 0)` — 10–100x faster
- Avoid `CrossJoin` of two large sets; use `NonEmptyCrossjoin` if available
- Calculated members defeat cache — push computation into rules where reused

## Common Errors

- `Unknown member` — missing bracket: `[Dim].[Member]` not `[Dim].Member`
- `Function ... expects a set` — wrap single member in `{ }`: `{ [Dim].[Member] }`
- `Hierarchy ... appears more than once` — same dim used in two axes/slicer; pick one
- `Calculation is too deep` — recursive rule referenced via MDX; check rules for circular feeders
