# TurboIntegrator (TI) Syntax Reference

## Control Flow

```ti
IF ( condition );
  # body
ELSEIF ( condition );
  # body
ELSE;
  # body
ENDIF;

WHILE ( condition );
  # body
END;
```

Statements end with `;`. Comments start with `#`. No `FOR` loop — use `WHILE` with a counter.

## Variables and Types

Variables are dynamically typed. Numeric and string co-exist.

```ti
sCubeName = 'Sales';
nValue = 100;
sFormatted = NumberToString( nValue );
nParsed = StringToNumber( '42' );
```

Naming convention: `s` prefix for strings, `n` for numbers, `v` for views/subsets. Not enforced; widely followed.

## Common Functions — Strings

- `SCAN( substr, str )` — 1-based position, 0 if not found
- `SUBST( str, start, length )` — substring (1-based)
- `LONG( str )` — length
- `UPPER( str )`, `LOWER( str )`, `TRIM( str )`
- `FILL( char, n )` — repeat char n times

## Common Functions — Numbers

- `INT( n )` — truncate toward zero
- `ROUND( n )` — round half-up
- `ABS( n )`, `SIGN( n )`, `MOD( n, divisor )`

## Cube Cell I/O

- `CellGetN( 'CubeName', 'el1', 'el2', ... )` — numeric read
- `CellGetS( 'CubeName', 'el1', 'el2', ... )` — string read
- `CellPutN( value, 'CubeName', 'el1', 'el2', ... )` — numeric write
- `CellPutS( value, 'CubeName', 'el1', 'el2', ... )` — string write
- `CellIncrementN( value, 'CubeName', ... )` — atomic add

Element order matches the cube's dimension order. Wrong order silently writes to a different cell.

## Dimension Manipulation

- `DimensionElementInsert( 'DimName', 'AfterElem', 'NewElem', 'N' )` — types: 'N' numeric, 'S' string, 'C' consolidated
- `DimensionElementDelete( 'DimName', 'Elem' )`
- `DimensionElementComponentAdd( 'DimName', 'ParentElem', 'ChildElem', 1.0 )` — last arg is weight
- `DimensionDeleteAllElements( 'DimName' )` — destructive; use in metadata tab for rebuilds

## ASCIIOUTPUT — Logging

```ti
ASCIIOUTPUT( 'C:\TM1\Logs\my-trace.log', sCubeName, NumberToString(nValue) );
```

Appends a line. Each argument becomes a comma-quoted field. Use absolute paths; relative paths resolve against TM1 server's `Logging` dir on most installs.

## Data Source Setup (Data tab prerequisites)

For ODBC/CSV processes, use `DatasourceNameForServer` and variable references like `v1`, `v2` for column values:

```ti
# Prolog or Data tab
nQty = NumberToString( v3 );
CellPutN( nQty, 'Sales', v1, v2, 'Quantity' );
```

`v1`, `v2`, ... are auto-generated from the configured datasource.

## Process Exit Codes

- `ProcessQuit;` — abort cleanly
- `ProcessError;` — abort with error status (sets `ProcessExitMajorError` for the caller)
- `ProcessBreak;` — stop data loop but continue to epilog

## Calling Other Processes

```ti
nRc = ExecuteProcess( 'OtherProcess', 'pParam1', sVal1, 'pParam2', nVal2 );
IF ( nRc <> ProcessExitNormal() );
  ASCIIOUTPUT( 'errors.log', 'OtherProcess failed' );
  ProcessError;
ENDIF;
```

Return codes: `ProcessExitNormal()`, `ProcessExitMinorError()`, `ProcessExitMajorError()`, `ProcessExitByQuit()`, `ProcessExitWithMessage()`.

## Common Gotchas

- String comparisons are case-sensitive
- Single quotes for string literals; double quotes are a parse error
- `IF ( a = b );` — single `=` for comparison, not `==`
- No early `RETURN` from a process — guard with `IF` blocks or use `ProcessQuit`
- Element references are case-insensitive in TM1 lookups but case-sensitive in TI string comparisons against retrieved names
