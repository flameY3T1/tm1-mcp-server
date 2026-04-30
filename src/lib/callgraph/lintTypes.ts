/** Schweregrad einer Lint-Diagnose */
export type LintSeverity = 'error' | 'warning' | 'hint';

/** TM1 Prozessabschnitt */
export type TiSection = 'prolog' | 'metadata' | 'data' | 'epilog';

/** Alle bekannten Regel-IDs des TI-Linters */
export type LintRuleId =
  | 'endless-loop'
  | 'wrong-arg-count'
  | 'string-compare-without-at'
  | 'numeric-compare-with-at'
  | 'type-mismatch-assignment'
  | 'wrong-param-type'
  | 'unused-variable'
  | 'dead-store'
  | 'empty-if'
  | 'empty-while'
  | 'cellput-no-error-handling'
  | 'unknown-function'
  | 'missing-semicolon'
  | 'wrong-section'
  | 'undefined-variable'
  | 'v12-deprecated'
  | 'ti-unknown-cube'
  | 'ti-unknown-dimension'
  | 'dead-code-condition'
  | 'tm1-error-code'
  | 'performance-hint';

/** Eine einzelne Lint-Diagnose */
export interface LintDiagnose {
  /** 1-basierte Zeilennummer */
  line: number;
  /** Schweregrad */
  severity: LintSeverity;
  /** Regel-ID */
  ruleId: LintRuleId;
  /** Deutsche Fehlermeldung, mit Regel-ID-Präfix: [rule-id] Meldung */
  message: string;
}

/** Datentyp einer TI-Variable */
export type VariableType = 'string' | 'numeric';

/** Informationen über eine inferierte Variable */
export interface VariableInfo {
  type: VariableType;
  /** Zeile der ersten Zuweisung */
  firstAssignmentLine: number;
}

/** Key: Variablenname in Lowercase */
export type VariableTypeMap = Map<string, VariableInfo>;
