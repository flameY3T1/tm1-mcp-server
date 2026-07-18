/** Severity of a lint diagnostic */
export type LintSeverity = 'error' | 'warning' | 'hint';

/** TM1 process section */
export type TiSection = 'prolog' | 'metadata' | 'data' | 'epilog';

/** All known rule IDs of the TI linter */
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

/** A single lint diagnostic */
export interface LintDiagnose {
  /** 1-based line number */
  line: number;
  /** Severity */
  severity: LintSeverity;
  /** Rule ID */
  ruleId: LintRuleId;
  /** Error message with rule-ID prefix: [rule-id] message */
  message: string;
}

/** Data type of a TI variable */
export type VariableType = 'string' | 'numeric';

/** Information about an inferred variable */
export interface VariableInfo {
  type: VariableType;
  /** Line of the first assignment */
  firstAssignmentLine: number;
}

/** Key: variable name in lowercase */
export type VariableTypeMap = Map<string, VariableInfo>;
