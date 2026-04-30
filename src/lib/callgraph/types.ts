/** Ergebnis des Parsers */
export type TiParseResult =
  | { ok: true; ast: TiAst }
  | { ok: false; error: TiParseError };

export interface TiParseError {
  line: number;
  message: string;
}

/** AST = Array von Statements */
export type TiAst = TiStatement[];

export type TiStatement =
  | TiAssignment
  | TiIfBlock
  | TiWhileBlock
  | TiFunctionCall;

export interface TiAssignment {
  type: 'assignment';
  variable: string;
  expression: string;
  /** true wenn der Ausdruck CellGetN/CellGetS enthält */
  isExternal: boolean;
  /** Falls isExternal: Funktionsname und Parameter */
  cellGetInfo?: { fn: 'CellGetN' | 'CellGetS'; params: string[] };
  line: number;
}

export interface TiIfBlock {
  type: 'if';
  condition: string;
  thenBody: TiStatement[];
  elseIfClauses: Array<{ condition: string; body: TiStatement[]; line: number }>;
  elseBody: TiStatement[];
  line: number;
}

export interface TiWhileBlock {
  type: 'while';
  condition: string;
  body: TiStatement[];
  line: number;
}

export interface TiFunctionCall {
  type: 'functionCall';
  name: string;
  args: string[];
  line: number;
}
