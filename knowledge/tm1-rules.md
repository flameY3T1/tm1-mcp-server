# TM1 Cube Rules

## Rule File Structure

Each cube has a single rule file. Sections in order:

```
SKIPCHECK;
FEEDSTRINGS;

# Calculation rules
['Element1','Element2'] = N: <expression>;
['StringMeasure'] = S: <expression>;

FEEDERS;

# Feeders
['SourceElement1','SourceElement2'] => ['TargetElement1','TargetElement2'];
```

- `SKIPCHECK` — assume the cube is sparse; only compute cells reached by feeders. **Required for any cube with rules touching consolidations**, otherwise TM1 scans every cell.
- `FEEDSTRINGS` — allow feeders on string cells. Add only if rules write string measures.

## Rule Syntax

```rule
['Sales','USD'] = N: ['Sales','EUR'] * ['FXRate','USD'];
```

LHS is a "rule area": dimension element references in `[ ]`, comma-separated. Order is irrelevant — TM1 matches by element name.

- `N:` — numeric rule
- `S:` — string rule
- `C:` — consolidated-only (rare; calculation applies only to consolidations)

## Element Targeting

- `['ElemA','ElemB']` — exact intersection
- `['ElemA']` — applies to all cells where ElemA is in scope
- Use `}ElementAttributes_<DimName>` lookups: `ATTRS( '<Dim>', !<Dim>, 'Region' )` returns attribute value for the current element

## Common Functions in Rules

- `DB( 'CubeName', e1, e2, ... )` — read from another cube
- `IF( cond, true_val, false_val )` — ternary
- `STET` — return the stored value (skip rule for this cell)
- `CONTINUE` — proceed to next matching rule

## Feeders

Feeders mark which cells contribute to which targets. Without correct feeders + SKIPCHECK, consolidations show wrong totals.

```feeders
['Sales','EUR'] => ['Sales','USD'];
```

Reads: "any cell at ['Sales','EUR'] feeds the calculation at ['Sales','USD']."

### Rules of Thumb

- **Every rule needs a feeder** unless the calculation only references constants
- Feed from leaf to leaf — never feed consolidations
- Feeder LHS = source side of rule; RHS = target
- For `DB('OtherCube', ...)` cross-cube reads, the feeder must live in the source cube and target this cube

### Multiple Feeders

```feeders
['Sales','EUR'] => ['Sales','USD'], ['Sales','GBP'];
```

Comma-separated targets on the RHS.

## SKIPCHECK Gotchas

- With `SKIPCHECK;` and missing feeder: target cell reads as zero (silently). Total is wrong.
- Without `SKIPCHECK;`: every cell is checked, full table scans, slow.
- Default for any new cube with rules: **add SKIPCHECK first, then rules, then feeders**.

## Performance

- Rules are evaluated cell-by-cell at query time. Heavy rules block queries.
- Push computation to TI (write to cube) when source data is stable
- Use rules for derived values that depend on user input or volatile sources
- `DB()` is fast but adds dependency — too many cross-cube reads kill cache reuse
- Avoid `IF` nesting > 3 levels; precompute in TI

## Debugging Rules

- TM1 Architect / PA Workspace: right-click cell → "Trace Calculation" shows the rule path
- MCP: `tm1_get_all_cube_rules` to inspect, `tm1_check_cube_rule` to validate syntax before deploy
- A rule that compiles but is unfed produces correct leaf values but wrong consolidations — verify against a known total

## Example: Currency Conversion

```rule
SKIPCHECK;

['Amount','USD'] = N:
  IF( !Currency @= 'USD', STET, DB( 'FX', 'USD', !Date, 'Rate' ) * DB( 'Sales', !Period, !Customer, 'Amount', 'EUR' ) );

FEEDERS;

['Amount','EUR'] => ['Amount','USD'];
```

`!Dim` syntax = current element of dimension `Dim`. `@=` is case-insensitive string equality.
