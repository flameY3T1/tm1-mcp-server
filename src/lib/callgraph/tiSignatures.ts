import type { TiSection } from './lintTypes.js';

/** Type information for a single function parameter */
export interface TiParamInfo {
  name: string;
  type: 'string' | 'numeric' | 'any';
}

/** Signature of a known TI function */
export interface TiKnownSignature {
  name: string;
  minParams: number;
  maxParams: number; // Infinity for variadic functions
  params: TiParamInfo[];
  returnType: 'string' | 'numeric' | 'void';
  /** true if the function is no longer available in TM1 / Planning Analytics v12 (Cloud Native) */
  deprecatedInV12?: boolean;
  /**
   * Performance note: recommendation for which section the function should ideally appear in.
   * Emitted as a `performance-hint` when the function is used outside the recommended section.
   */
  performanceNote?: { recommended: TiSection; reason: string };
}

/**
 * Map of all known TI function signatures.
 * Key is the function name in lowercase for case-insensitive lookup.
 * Extracted from the SIGNATURES map in tm1SignatureHelpProvider.ts,
 * enriched with return types and parameter type information.
 */
export const KNOWN_SIGNATURES: Map<string, TiKnownSignature> = new Map([
  // ── Cell functions ──────────────────────────────────────────────────────────
  ['cellgetn', {
    name: 'CellGetN',
    minParams: 3,
    maxParams: Infinity,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'Elem1', type: 'string' },
      { name: 'ElemN', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['cellgets', {
    name: 'CellGetS',
    minParams: 3,
    maxParams: Infinity,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'Elem1', type: 'string' },
      { name: 'ElemN', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['cellputn', {
    name: 'CellPutN',
    minParams: 4,
    maxParams: Infinity,
    params: [
      { name: 'Value', type: 'numeric' },
      { name: 'CubeName', type: 'string' },
      { name: 'Elem1', type: 'string' },
      { name: 'ElemN', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['cellputs', {
    name: 'CellPutS',
    minParams: 4,
    maxParams: Infinity,
    params: [
      { name: 'Value', type: 'string' },
      { name: 'CubeName', type: 'string' },
      { name: 'Elem1', type: 'string' },
      { name: 'ElemN', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['cellexists', {
    name: 'CellExists',
    minParams: 3,
    maxParams: Infinity,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ElemN', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['cellisundefined', {
    name: 'CellIsUndefined',
    minParams: 3,
    maxParams: Infinity,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ElemN', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['cellisrule', {
    name: 'CellIsRule',
    minParams: 3,
    maxParams: Infinity,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ElemN', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['cellisupdateable', {
    name: 'CellIsUpdateable',
    minParams: 3,
    maxParams: Infinity,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ElemN', type: 'string' },
    ],
    returnType: 'numeric',
  }],

  // ── String functions ─────────────────────────────────────────────────────────
  ['str', {
    name: 'STR',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'Number', type: 'numeric' },
      { name: 'Width', type: 'numeric' },
      { name: 'Decimals', type: 'numeric' },
    ],
    returnType: 'string',
  }],
  ['subst', {
    name: 'SUBST',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'String', type: 'string' },
      { name: 'Start', type: 'numeric' },
      { name: 'Length', type: 'numeric' },
    ],
    returnType: 'string',
  }],
  ['scan', {
    name: 'SCAN',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'Substring', type: 'string' },
      { name: 'String', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['trim', {
    name: 'TRIM',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'String', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['ltrim', {
    name: 'LTRIM',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'String', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['rtrim', {
    name: 'RTRIM',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'String', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['upper', {
    name: 'UPPER',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'String', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['lower', {
    name: 'LOWER',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'String', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['long', {
    name: 'LONG',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'String', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['char', {
    name: 'CHAR',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'Number', type: 'numeric' },
    ],
    returnType: 'string',
  }],
  ['code', {
    name: 'CODE',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'String', type: 'string' },
      { name: 'Position', type: 'numeric' },
    ],
    returnType: 'numeric',
  }],
  ['fill', {
    name: 'FILL',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'String', type: 'string' },
      { name: 'Length', type: 'numeric' },
    ],
    returnType: 'string',
  }],
  ['capit', {
    name: 'CAPIT',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'String', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['delet', {
    name: 'DELET',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'String', type: 'string' },
      { name: 'Start', type: 'numeric' },
      { name: 'Length', type: 'numeric' },
    ],
    returnType: 'string',
  }],
  ['insrt', {
    name: 'INSRT',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'Insert', type: 'string' },
      { name: 'String', type: 'string' },
      { name: 'Position', type: 'numeric' },
    ],
    returnType: 'string',
  }],
  ['numbr', {
    name: 'NUMBR',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'String', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['expand', {
    name: 'Expand',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'String', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['numbertostring', {
    name: 'NumberToString',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'Number', type: 'numeric' },
    ],
    returnType: 'string',
  }],
  ['stringtonumber', {
    name: 'StringToNumber',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'String', type: 'string' },
    ],
    returnType: 'numeric',
  }],

  // ── Math functions ────────────────────────────────────────────────────────────
  ['abs', {
    name: 'ABS',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'Number', type: 'numeric' },
    ],
    returnType: 'numeric',
  }],
  ['int', {
    name: 'INT',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'Number', type: 'numeric' },
    ],
    returnType: 'numeric',
  }],
  ['round', {
    name: 'ROUND',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'Number', type: 'numeric' },
      { name: 'Decimals', type: 'numeric' },
    ],
    returnType: 'numeric',
  }],
  ['mod', {
    name: 'MOD',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'Number', type: 'numeric' },
      { name: 'Divisor', type: 'numeric' },
    ],
    returnType: 'numeric',
  }],
  ['max', {
    name: 'MAX',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'Number1', type: 'numeric' },
      { name: 'Number2', type: 'numeric' },
    ],
    returnType: 'numeric',
  }],
  ['min', {
    name: 'MIN',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'Number1', type: 'numeric' },
      { name: 'Number2', type: 'numeric' },
    ],
    returnType: 'numeric',
  }],
  ['power', {
    name: 'POWER',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'Base', type: 'numeric' },
      { name: 'Exponent', type: 'numeric' },
    ],
    returnType: 'numeric',
  }],
  ['sqrt', {
    name: 'SQRT',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'Number', type: 'numeric' },
    ],
    returnType: 'numeric',
  }],
  ['sin', {
    name: 'SIN',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'Angle', type: 'numeric' },
    ],
    returnType: 'numeric',
  }],
  ['log', {
    name: 'LOG',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'Number', type: 'numeric' },
    ],
    returnType: 'numeric',
  }],
  ['log10', {
    name: 'LOG10',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'Number', type: 'numeric' },
    ],
    returnType: 'numeric',
  }],
  ['exp', {
    name: 'EXP',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'Number', type: 'numeric' },
    ],
    returnType: 'numeric',
  }],
  ['rand', {
    name: 'RAND',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'numeric',
  }],

  // ── Date/time functions ───────────────────────────────────────────────────────
  ['today', {
    name: 'TODAY',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'Format', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['now', {
    name: 'NOW',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'Format', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['date', {
    name: 'DATE',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'Days', type: 'numeric' },
      { name: 'Format', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['dayno', {
    name: 'DAYNO',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'DateString', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['timst', {
    name: 'TIMST',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'Time', type: 'numeric' },
      { name: 'Format', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['year', {
    name: 'YEAR',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'DateString', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['month', {
    name: 'MONTH',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'DateString', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['day', {
    name: 'DAY',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'DateString', type: 'string' },
    ],
    returnType: 'numeric',
  }],

  // ── Dimension/Element functions ───────────────────────────────────────────────
  ['dimsiz', {
    name: 'DIMSIZ',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'DimensionName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['dimnm', {
    name: 'DIMNM',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'Index', type: 'numeric' },
    ],
    returnType: 'string',
  }],
  ['dimix', {
    name: 'DIMIX',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['dtype', {
    name: 'DTYPE',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['dnlev', {
    name: 'DNLEV',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'DimensionName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['dnxt', {
    name: 'DNXT',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['elpar', {
    name: 'ELPAR',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'ParentIndex', type: 'numeric' },
    ],
    returnType: 'string',
  }],
  ['elparn', {
    name: 'ELPARN',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['ellev', {
    name: 'ELLEV',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['elcomp', {
    name: 'ELCOMP',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'ChildIndex', type: 'numeric' },
    ],
    returnType: 'string',
  }],
  ['elcompn', {
    name: 'ELCOMPN',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['elweight', {
    name: 'ELWEIGHT',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ParentName', type: 'string' },
      { name: 'ChildName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['elisanc', {
    name: 'ELISANC',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'AncestorName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['elisdesc', {
    name: 'ELISDESC',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'DescendantName', type: 'string' },
    ],
    returnType: 'numeric',
  }],

  // ── Attribute functions ───────────────────────────────────────────────────────
  ['attrs', {
    name: 'ATTRS',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['attrn', {
    name: 'ATTRN',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['attributeput', {
    name: 'AttributePut',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'Value', type: 'any' },
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['attrputs', {
    name: 'AttrPutS',
    minParams: 4,
    maxParams: 6,
    params: [
      { name: 'Value', type: 'string' },
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      // 5./6. Arg überladen: LocaleCode (string) ODER PassSecurity (numeric).
      { name: 'LocaleOrPassSecurity', type: 'any' },
      { name: 'PassSecurity', type: 'any' },
    ],
    returnType: 'void',
  }],
  ['attrputn', {
    name: 'AttrPutN',
    minParams: 4,
    maxParams: 6,
    params: [
      { name: 'Value', type: 'numeric' },
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      // 5./6. Arg überladen: LocaleCode (string) ODER PassSecurity (numeric).
      { name: 'LocaleOrPassSecurity', type: 'any' },
      { name: 'PassSecurity', type: 'any' },
    ],
    returnType: 'void',
  }],
  ['elementsecurityput', {
    name: 'ElementSecurityPut',
    minParams: 4,
    maxParams: 4,
    params: [
      // Level ist String-Code ('None' | 'Read' | 'Write' | 'Reserve' | 'Lock' | 'Admin').
      { name: 'Level', type: 'string' },
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'GroupName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['serversandboxexists', {
    name: 'ServerSandboxExists',
    minParams: 1,
    maxParams: 2,
    params: [
      { name: 'SandboxName', type: 'string' },
      // Optional: prüft Sandbox-Existenz für anderen User. Default = aufrufender User.
      { name: 'UserName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['stringtonumberex', {
    name: 'StringToNumberEx',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'String', type: 'string' },
      { name: 'DecimalSeparator', type: 'string' },
      { name: 'ThousandSeparator', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['setinputcharacterset', {
    name: 'SetInputCharacterSet',
    minParams: 1,
    maxParams: 2,
    params: [
      // 1-arg: nur CharacterSet (aktuelle Datasource). 2-arg: (FileName, CharacterSet).
      { name: 'FileNameOrCharacterSet', type: 'string' },
      { name: 'CharacterSet', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['attributeget', {
    name: 'AttributeGet',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'string',
  }],

  // ── Cube-Attribute (Task 3a) ─────────────────────────────────────────────────
  ['cubeattrn', {
    name: 'CubeAttrN',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['cubeattrs', {
    name: 'CubeAttrS',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['cubeattrnl', {
    name: 'CubeAttrNL',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['cubeattrsl', {
    name: 'CubeAttrSL',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['cubeattrputn', {
    name: 'CubeAttrPutN',
    minParams: 3,
    maxParams: 4,
    params: [
      { name: 'Value', type: 'numeric' },
      { name: 'CubeName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['cubeattrputs', {
    name: 'CubeAttrPutS',
    minParams: 3,
    maxParams: 4,
    params: [
      { name: 'Value', type: 'string' },
      { name: 'CubeName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['cubeattrinsert', {
    name: 'CubeAttrInsert',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'PreviousAttributeName', type: 'string' },
      { name: 'NewAttributeName', type: 'string' },
      { name: 'AttributeType', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['cubeattrdelete', {
    name: 'CubeAttrDelete',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'void',
  }],

  // ── Dimension-Attribute (Task 3b) ────────────────────────────────────────────
  ['dimensionattrn', {
    name: 'DimensionAttrN',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['dimensionattrs', {
    name: 'DimensionAttrS',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['dimensionattrnl', {
    name: 'DimensionAttrNL',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['dimensionattrsl', {
    name: 'DimensionAttrSL',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['dimensionattrputn', {
    name: 'DimensionAttrPutN',
    minParams: 3,
    maxParams: 4,
    params: [
      { name: 'Value', type: 'numeric' },
      { name: 'DimensionName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['dimensionattrputs', {
    name: 'DimensionAttrPutS',
    minParams: 3,
    maxParams: 4,
    params: [
      { name: 'Value', type: 'string' },
      { name: 'DimensionName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['dimensionattrinsert', {
    name: 'DimensionAttrInsert',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'PreviousAttributeName', type: 'string' },
      { name: 'NewAttributeName', type: 'string' },
      { name: 'AttributeType', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['dimensionattrdelete', {
    name: 'DimensionAttrDelete',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'void',
  }],

  // ── Chore-Attribute (Task 3c) ────────────────────────────────────────────────
  ['choreattrn', {
    name: 'ChoreAttrN',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'ChoreName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['choreattrs', {
    name: 'ChoreAttrS',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'ChoreName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['choreattrnl', {
    name: 'ChoreAttrNL',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'ChoreName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['choreattrsl', {
    name: 'ChoreAttrSL',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'ChoreName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['choreattrputn', {
    name: 'ChoreAttrPutN',
    minParams: 3,
    maxParams: 4,
    params: [
      { name: 'Value', type: 'numeric' },
      { name: 'ChoreName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['choreattrputs', {
    name: 'ChoreAttrPutS',
    minParams: 3,
    maxParams: 4,
    params: [
      { name: 'Value', type: 'string' },
      { name: 'ChoreName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['choreattrinsert', {
    name: 'ChoreAttrInsert',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'PreviousAttributeName', type: 'string' },
      { name: 'NewAttributeName', type: 'string' },
      { name: 'AttributeType', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['choreattrdelete', {
    name: 'ChoreAttrDelete',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'void',
  }],

  // ── View-Attribute (Task 3d) — View identifiziert über Cube + View ──────────
  ['viewattrn', {
    name: 'ViewAttrN',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['viewattrs', {
    name: 'ViewAttrS',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['viewattrnl', {
    name: 'ViewAttrNL',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['viewattrsl', {
    name: 'ViewAttrSL',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['viewattrputn', {
    name: 'ViewAttrPutN',
    minParams: 4,
    maxParams: 5,
    params: [
      { name: 'Value', type: 'numeric' },
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['viewattrputs', {
    name: 'ViewAttrPutS',
    minParams: 4,
    maxParams: 5,
    params: [
      { name: 'Value', type: 'string' },
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['viewattrinsert', {
    name: 'ViewAttrInsert',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'PreviousAttributeName', type: 'string' },
      { name: 'NewAttributeName', type: 'string' },
      { name: 'AttributeType', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['viewattrdelete', {
    name: 'ViewAttrDelete',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'void',
  }],

  // ── Subset-Attribute (Task 3e) — Subset identifiziert über Dim + Subset ─────
  ['subsetattrn', {
    name: 'SubsetAttrN',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['subsetattrs', {
    name: 'SubsetAttrS',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['subsetattrnl', {
    name: 'SubsetAttrNL',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['subsetattrsl', {
    name: 'SubsetAttrSL',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['subsetattrputn', {
    name: 'SubsetAttrPutN',
    minParams: 4,
    maxParams: 5,
    params: [
      { name: 'Value', type: 'numeric' },
      { name: 'DimensionName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['subsetattrputs', {
    name: 'SubsetAttrPutS',
    minParams: 4,
    maxParams: 5,
    params: [
      { name: 'Value', type: 'string' },
      { name: 'DimensionName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['subsetattrinsert', {
    name: 'SubsetAttrInsert',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'PreviousAttributeName', type: 'string' },
      { name: 'NewAttributeName', type: 'string' },
      { name: 'AttributeType', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['subsetattrdelete', {
    name: 'SubsetAttrDelete',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'void',
  }],

  // ── Legacy / Element-Attr-Erweiterungen (Task 3f) ────────────────────────────
  ['attrdelete', {
    name: 'AttrDelete',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['attrinsert', {
    name: 'AttrInsert',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'PreviousAttributeName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'AttributeType', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['attrnl', {
    name: 'AttrNL',
    minParams: 3,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['attrsl', {
    name: 'AttrSL',
    minParams: 3,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['elementattrnl', {
    name: 'ElementAttrNL',
    minParams: 3,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['elementattrsl', {
    name: 'ElementAttrSL',
    minParams: 3,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['elementattrputn', {
    name: 'ElementAttrPutN',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'Value', type: 'numeric' },
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['elementattrputs', {
    name: 'ElementAttrPutS',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'Value', type: 'string' },
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'void',
  }],

  // ── Process control ───────────────────────────────────────────────────────────
  ['executeprocess', {
    name: 'ExecuteProcess',
    minParams: 1,
    maxParams: Infinity,
    params: [
      { name: 'ProcessName', type: 'string' },
      { name: 'ParamName', type: 'string' },
      { name: 'ParamValue', type: 'any' },
    ],
    returnType: 'void',
  }],
  ['runprocess', {
    name: 'RunProcess',
    minParams: 1,
    maxParams: Infinity,
    params: [
      { name: 'ProcessName', type: 'string' },
      { name: 'ParamName', type: 'string' },
      { name: 'ParamValue', type: 'any' },
    ],
    returnType: 'void',
  }],
  ['processexitnormal', {
    name: 'ProcessExitNormal',
    minParams: 0, maxParams: 0, params: [], returnType: 'numeric',
  }],
  ['processexitminorerror', {
    name: 'ProcessExitMinorError',
    minParams: 0, maxParams: 0, params: [], returnType: 'numeric',
  }],
  ['processexitseriouserror', {
    name: 'ProcessExitSeriousError',
    minParams: 0, maxParams: 0, params: [], returnType: 'numeric',
  }],
  ['processexitbybreak', {
    name: 'ProcessExitByBreak',
    minParams: 0, maxParams: 0, params: [], returnType: 'numeric',
  }],
  ['processexitbyquit', {
    name: 'ProcessExitByQuit',
    minParams: 0, maxParams: 0, params: [], returnType: 'numeric',
  }],
  ['processexitoninit', {
    name: 'ProcessExitOnInit',
    minParams: 0, maxParams: 0, params: [], returnType: 'numeric',
  }],
  ['processexitwithmessage', {
    name: 'ProcessExitWithMessage',
    minParams: 0, maxParams: 0, params: [], returnType: 'numeric',
  }],
  ['processexitbychorequit', {
    name: 'ProcessExitByChoreQuit',
    minParams: 0, maxParams: 0, params: [], returnType: 'numeric',
  }],
  ['processexitbychorerollback', {
    name: 'ProcessExitByChoreRollback',
    minParams: 0, maxParams: 0, params: [], returnType: 'numeric',
  }],
  ['processexitbyprocessrollback', {
    name: 'ProcessExitByProcessRollback',
    minParams: 0, maxParams: 0, params: [], returnType: 'numeric',
  }],
  ['logoutput', {
    name: 'LogOutput',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'Severity', type: 'string' },
      { name: 'Message', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['asciioutput', {
    name: 'ASCIIOutput',
    minParams: 2,
    maxParams: Infinity,
    params: [
      { name: 'FileName', type: 'string' },
      { name: 'Value1', type: 'any' },
      { name: 'ValueN', type: 'any' },
    ],
    returnType: 'void',
  }],
  ['textoutput', {
    name: 'TextOutput',
    minParams: 2,
    maxParams: Infinity,
    params: [
      { name: 'FileName', type: 'string' },
      { name: 'Value1', type: 'any' },
      { name: 'ValueN', type: 'any' },
    ],
    returnType: 'void',
  }],
  ['threadsleep', {
    name: 'ThreadSleep',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'Milliseconds', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['savedataall', {
    name: 'SaveDataAll',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['servername', {
    name: 'ServerName',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'string',
  }],
  ['getprocessname', {
    name: 'GetProcessName',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'string',
  }],
  ['getcurrentuser', {
    name: 'GetCurrentUser',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'string',
  }],

  // ── Validation ────────────────────────────────────────────────────────────────
  ['isnumeric', {
    name: 'ISNUMERIC',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'String', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['isundefined', {
    name: 'ISUNDEFINED',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'Value', type: 'any' },
    ],
    returnType: 'numeric',
  }],

  // ── DimensionCreate, ElementInsert etc ────────────────────────────────────────
  ['dimensioncreate', {
    name: 'DimensionCreate',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'DimensionName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['elementinsert', {
    name: 'ElementInsert',
    minParams: 5,
    maxParams: 5,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ParentName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'Weight', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['subsetcreate', {
    name: 'SubsetCreate',
    minParams: 2,
    maxParams: 3,
    params: [
      { name: 'SubsetName', type: 'string' },
      { name: 'DimensionName', type: 'string' },
      { name: 'AsTemporary', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['subsetelementadd', {
    name: 'SubsetElementAdd',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'SubsetName', type: 'string' },
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['cubecreate', {
    name: 'CubeCreate',
    minParams: 3,
    maxParams: Infinity,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'Dim1', type: 'string' },
      { name: 'DimN', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['viewcreate', {
    name: 'ViewCreate',
    minParams: 2,
    maxParams: 3,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'AsTemporary', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['stringglobalvariable', {
    name: 'StringGlobalVariable',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'VariableName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['numericglobalvariable', {
    name: 'NumericGlobalVariable',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'VariableName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['securityrefresh', {
    name: 'SecurityRefresh',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'void',
  }],

  // ── Cube management ───────────────────────────────────────────────────────────
  ['cubedelete', {
    name: 'CubeDelete',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'CubeName', type: 'string' }],
    returnType: 'void',
  }],
  ['cubedestroy', {
    name: 'CubeDestroy',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'CubeName', type: 'string' }],
    returnType: 'void',
  }],
  ['cubeexists', {
    name: 'CubeExists',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'CubeName', type: 'string' }],
    returnType: 'numeric',
  }],
  ['tabdim', {
    name: 'TabDim',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'Index', type: 'numeric' },
    ],
    returnType: 'string',
  }],
  ['cubecleardata', {
    name: 'CubeClearData',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'CubeName', type: 'string' }],
    returnType: 'void',
  }],
  ['cubesetlogchanges', {
    name: 'CubeSetLogChanges',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'LogChanges', type: 'numeric' },
    ],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['cubegetlogchanges', {
    name: 'CubeGetLogChanges',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'CubeName', type: 'string' }],
    returnType: 'numeric',
    deprecatedInV12: true,
  }],
  ['cubegetn', {
    name: 'CubeGetN',
    minParams: 3,
    maxParams: Infinity,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'Elem1', type: 'string' },
      { name: 'ElemN', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['cubegets', {
    name: 'CubeGetS',
    minParams: 3,
    maxParams: Infinity,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'Elem1', type: 'string' },
      { name: 'ElemN', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['cubeputn', {
    name: 'CubePutN',
    minParams: 4,
    maxParams: Infinity,
    params: [
      { name: 'Value', type: 'numeric' },
      { name: 'CubeName', type: 'string' },
      { name: 'Elem1', type: 'string' },
      { name: 'ElemN', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['cubeputs', {
    name: 'CubePutS',
    minParams: 4,
    maxParams: Infinity,
    params: [
      { name: 'Value', type: 'string' },
      { name: 'CubeName', type: 'string' },
      { name: 'Elem1', type: 'string' },
      { name: 'ElemN', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['ruledestroy', {
    name: 'RuleDestroy',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'CubeName', type: 'string' }],
    returnType: 'void',
  }],
  ['ruleloadfromfile', {
    name: 'RuleLoadFromFile',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'FileName', type: 'string' },
    ],
    returnType: 'void',
  }],

  // ── Dimension management ──────────────────────────────────────────────────────
  ['dimensiondestroy', {
    name: 'DimensionDestroy',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'DimensionName', type: 'string' }],
    returnType: 'void',
  }],
  ['dimensionexists', {
    name: 'DimensionExists',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'DimensionName', type: 'string' }],
    returnType: 'numeric',
  }],
  ['dimensiondeleteallelements', {
    name: 'DimensionDeleteAllElements',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'DimensionName', type: 'string' }],
    returnType: 'void',
  }],
  ['dimensionelementinsert', {
    name: 'DimensionElementInsert',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'Position', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'ElementType', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['dimensionelementdelete', {
    name: 'DimensionElementDelete',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['dimensionelementmove', {
    name: 'DimensionElementMove',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'Position', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['dimensionelementcount', {
    name: 'DimensionElementCount',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'DimensionName', type: 'string' }],
    returnType: 'numeric',
  }],
  ['dimensionelementexists', {
    name: 'DimensionElementExists',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['dimensionelementcomponentadd', {
    name: 'DimensionElementComponentAdd',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ParentName', type: 'string' },
      { name: 'ChildName', type: 'string' },
      { name: 'Weight', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['dimensionelementcomponentdelete', {
    name: 'DimensionElementComponentDelete',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ParentName', type: 'string' },
      { name: 'ChildName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['dimensionsortorder', {
    name: 'DimensionSortOrder',
    minParams: 5,
    maxParams: 5,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'Order', type: 'string' },
      { name: 'SortingCriteria', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'void',
  }],

  // ── Element functions (long-form) ─────────────────────────────────────────────
  ['elementcount', {
    name: 'ElementCount',
    minParams: 1,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['elementdelete', {
    name: 'ElementDelete',
    minParams: 2,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['elementexists', {
    name: 'ElementExists',
    minParams: 2,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['elementindex', {
    name: 'ElementIndex',
    minParams: 2,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['elementname', {
    name: 'ElementName',
    minParams: 2,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'Index', type: 'numeric' },
    ],
    returnType: 'string',
  }],
  ['elementlevel', {
    name: 'ElementLevel',
    minParams: 2,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['elementtype', {
    name: 'ElementType',
    minParams: 2,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['elementparent', {
    name: 'ElementParent',
    minParams: 3,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'ParentIndex', type: 'numeric' },
    ],
    returnType: 'string',
  }],
  ['elementparentcount', {
    name: 'ElementParentCount',
    minParams: 2,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['elementcomponent', {
    name: 'ElementComponent',
    minParams: 3,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'ChildIndex', type: 'numeric' },
    ],
    returnType: 'string',
  }],
  ['elementcomponentcount', {
    name: 'ElementComponentCount',
    minParams: 2,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['elementweight', {
    name: 'ElementWeight',
    minParams: 3,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ParentName', type: 'string' },
      { name: 'ChildName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['elementattrn', {
    name: 'ElementAttrN',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['elementattrs', {
    name: 'ElementAttrS',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['elementattrinsert', {
    name: 'ElementAttrInsert',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'PreviousAttributeName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'AttributeType', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['elementattrdelete', {
    name: 'ElementAttrDelete',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'void',
  }],

  // ── Hierarchy-Attr (Task 1a) — Hierarchy-Level-Attribute ─────────────────────
  ['hierarchyattrn', {
    name: 'HierarchyAttrN',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['hierarchyattrs', {
    name: 'HierarchyAttrS',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['hierarchyattrnl', {
    name: 'HierarchyAttrNL',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['hierarchyattrsl', {
    name: 'HierarchyAttrSL',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['hierarchyattrputn', {
    name: 'HierarchyAttrPutN',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'Value', type: 'numeric' },
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['hierarchyattrputs', {
    name: 'HierarchyAttrPutS',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'Value', type: 'string' },
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'void',
  }],

  // ── Legacy short-form element functions ───────────────────────────────────────
  ['elispar', {
    name: 'ELISPAR',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'ParentName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['elisstr', {
    name: 'ELISSTR',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['elisattr', {
    name: 'ELISATTR',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'numeric',
  }],

  // ── Hierarchy management ──────────────────────────────────────────────────────
  ['hierarchycreate', {
    name: 'HierarchyCreate',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['hierarchyexists', {
    name: 'HierarchyExists',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['hierarchyelementcount', {
    name: 'HierarchyElementCount',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['hierarchyelementinsert', {
    name: 'HierarchyElementInsert',
    minParams: 6,
    maxParams: 6,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ParentName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'ElementType', type: 'string' },
      { name: 'Weight', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['hierarchyelementdelete', {
    name: 'HierarchyElementDelete',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['hierarchyelementcomponentadd', {
    name: 'HierarchyElementComponentAdd',
    minParams: 5,
    maxParams: 5,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ParentName', type: 'string' },
      { name: 'ChildName', type: 'string' },
      { name: 'Weight', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['hierarchyname', {
    name: 'HierarchyName',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'Index', type: 'numeric' },
    ],
    returnType: 'string',
  }],

  // ── Hierarchy Core (Task 1b) ─────────────────────────────────────────────────
  ['hierarchydestroy', {
    name: 'HierarchyDestroy',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['hierarchydeleteallelements', {
    name: 'HierarchyDeleteAllElements',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['hierarchydeleteelements', {
    name: 'HierarchyDeleteElements',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['hierarchycontainsallleaves', {
    name: 'HierarchyContainsAllLeaves',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['hierarchyhasorphanedleaves', {
    name: 'HierarchyHasOrphanedLeaves',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['hierarchytimelastupdated', {
    name: 'HierarchyTimeLastUpdated',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['hierarchyupdatedirect', {
    name: 'HierarchyUpdateDirect',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['hierarchysortorder', {
    name: 'HierarchySortOrder',
    minParams: 6,
    maxParams: 6,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ComponentSortType', type: 'string' },
      { name: 'ComponentSortSense', type: 'string' },
      { name: 'ElementSortType', type: 'string' },
      { name: 'ElementSortSense', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['hierarchytopelementinsert', {
    name: 'HierarchyTopElementInsert',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'InsertionPoint', type: 'numeric' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['hierarchytopelementinsertdirect', {
    name: 'HierarchyTopElementInsertDirect',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'InsertionPoint', type: 'numeric' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'void',
  }],

  // ── Hierarchy Element (Task 1c) ──────────────────────────────────────────────
  ['hierarchyelementexists', {
    name: 'HierarchyElementExists',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['hierarchyelementdeletedirect', {
    name: 'HierarchyElementDeleteDirect',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['hierarchyelementinsertdirect', {
    name: 'HierarchyElementInsertDirect',
    minParams: 6,
    maxParams: 6,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ParentName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'ElementType', type: 'string' },
      { name: 'Weight', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['hierarchyelementprincipalname', {
    name: 'HierarchyElementPrincipalName',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['hierarchyelementcomponentadddirect', {
    name: 'HierarchyElementComponentAddDirect',
    minParams: 5,
    maxParams: 5,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ParentName', type: 'string' },
      { name: 'ChildName', type: 'string' },
      { name: 'Weight', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['hierarchyelementcomponentdelete', {
    name: 'HierarchyElementComponentDelete',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ParentName', type: 'string' },
      { name: 'ChildName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['hierarchyelementcomponentdeletedirect', {
    name: 'HierarchyElementComponentDeleteDirect',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ParentName', type: 'string' },
      { name: 'ChildName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['hierarchyelementsecurityget', {
    name: 'HierarchyElementSecurityGet',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'GroupName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['hierarchyelementsecurityput', {
    name: 'HierarchyElementSecurityPut',
    minParams: 5,
    maxParams: 5,
    params: [
      { name: 'Level', type: 'string' },
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'GroupName', type: 'string' },
    ],
    returnType: 'void',
  }],

  // ── Hierarchy Subset (Task 1d) ───────────────────────────────────────────────
  ['hierarchysubsetcreate', {
    name: 'HierarchySubsetCreate',
    minParams: 3,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'AsTemporary', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['hierarchysubsetdestroy', {
    name: 'HierarchySubsetDestroy',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['hierarchysubsetexists', {
    name: 'HierarchySubsetExists',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['hierarchysubsetdeleteallelements', {
    name: 'HierarchySubsetDeleteAllElements',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['hierarchysubsetelementinsert', {
    name: 'HierarchySubsetElementInsert',
    minParams: 5,
    maxParams: 5,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'Position', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['hierarchysubsetelementdelete', {
    name: 'HierarchySubsetElementDelete',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['hierarchysubsetelementexists', {
    name: 'HierarchySubsetElementExists',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['hierarchysubsetelementgetindex', {
    name: 'HierarchySubsetElementGetIndex',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['hierarchysubsetgetelementname', {
    name: 'HierarchySubsetGetElementName',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'Index', type: 'numeric' },
    ],
    returnType: 'string',
  }],
  ['hierarchysubsetgetsize', {
    name: 'HierarchySubsetGetSize',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['hierarchysubsetisallset', {
    name: 'HierarchySubsetIsAllSet',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'Flag', type: 'numeric' },
    ],
    returnType: 'numeric',
  }],
  ['hierarchysubsetmdxget', {
    name: 'HierarchySubsetMDXGet',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['hierarchysubsetmdxset', {
    name: 'HierarchySubsetMDXSet',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'MDXExpression', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['hierarchysubsetaliasget', {
    name: 'HierarchySubsetAliasGet',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['hierarchysubsetaliasset', {
    name: 'HierarchySubsetAliasSet',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'AliasName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['hierarchysubsetattrn', {
    name: 'HierarchySubsetAttrN',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['hierarchysubsetattrs', {
    name: 'HierarchySubsetAttrS',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['hierarchysubsetattrnl', {
    name: 'HierarchySubsetAttrNL',
    minParams: 5,
    maxParams: 5,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['hierarchysubsetattrsl', {
    name: 'HierarchySubsetAttrSL',
    minParams: 5,
    maxParams: 5,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'LocaleCode', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['hierarchysubsetattrputn', {
    name: 'HierarchySubsetAttrPutN',
    minParams: 5,
    maxParams: 5,
    params: [
      { name: 'Value', type: 'numeric' },
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['hierarchysubsetattrputs', {
    name: 'HierarchySubsetAttrPutS',
    minParams: 5,
    maxParams: 5,
    params: [
      { name: 'Value', type: 'string' },
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['hierarchysubsetattrinsert', {
    name: 'HierarchySubsetAttrInsert',
    minParams: 5,
    maxParams: 5,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'AttributeType', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['hierarchysubsetattrdelete', {
    name: 'HierarchySubsetAttrDelete',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'void',
  }],

  // ── Attribute management ──────────────────────────────────────────────────────
  ['attributecreate', {
    name: 'AttributeCreate',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
      { name: 'AttributeType', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['attributedelete', {
    name: 'AttributeDelete',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['attributeexists', {
    name: 'AttributeExists',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'AttributeName', type: 'string' },
    ],
    returnType: 'numeric',
  }],

  // ── Subset management ─────────────────────────────────────────────────────────
  ['subsetcreatebymdx', {
    name: 'SubsetCreateByMDX',
    // Two overloads with different positional types — type check skipped via 'any':
    //   Legacy:    (SubsetName, MDX, [AsTemporary])
    //   TM1 11.4+: (SubsetName, [DimensionName,] MDX, [AsTemporary])
    minParams: 2,
    maxParams: 4,
    params: [
      { name: 'SubsetName', type: 'string' },
      { name: 'DimensionName / MDX', type: 'any' },
      { name: 'MDX / AsTemporary', type: 'any' },
      { name: 'AsTemporary', type: 'any' },
    ],
    returnType: 'void',
  }],
  ['subsetdelete', {
    name: 'SubsetDelete',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'SubsetName', type: 'string' },
      { name: 'DimensionName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['subsetelementdelete', {
    name: 'SubsetElementDelete',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'SubsetName', type: 'string' },
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['subsetexists', {
    name: 'SubsetExists',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'SubsetName', type: 'string' },
      { name: 'DimensionName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['subsetgetelementname', {
    name: 'SubsetGetElementName',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'SubsetName', type: 'string' },
      { name: 'DimensionName', type: 'string' },
      { name: 'Index', type: 'numeric' },
    ],
    returnType: 'string',
  }],
  ['subsetgetsize', {
    name: 'SubsetGetSize',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'SubsetName', type: 'string' },
      { name: 'DimensionName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['subsettoset', {
    name: 'SubsetToSet',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'SubsetName', type: 'string' },
      { name: 'DimensionName', type: 'string' },
      { name: 'SetName', type: 'string' },
    ],
    returnType: 'void',
  }],

  // ── View management ───────────────────────────────────────────────────────────
  ['viewcreatebymdx', {
    name: 'ViewCreateByMDX',
    minParams: 3,
    maxParams: 4,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'MDX', type: 'string' },
      { name: 'AsTemporary', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['viewdelete', {
    name: 'ViewDelete',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['viewexists', {
    name: 'ViewExists',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['viewzero', {
    name: 'ViewZero',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['viewconstruct', {
    name: 'ViewConstruct',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['viewcolumndimensionset', {
    name: 'ViewColumnDimensionSet',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'DimensionName', type: 'string' },
      { name: 'Position', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['viewrowdimensionset', {
    name: 'ViewRowDimensionSet',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'DimensionName', type: 'string' },
      { name: 'Position', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['viewtitledimensionset', {
    name: 'ViewTitleDimensionSet',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'DimensionName', type: 'string' },
      { name: 'Position', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['viewtitleelementset', {
    name: 'ViewTitleElementSet',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['viewsubsetassign', {
    name: 'ViewSubsetAssign',
    minParams: 4,
    maxParams: 4,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'DimensionName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['viewextractskipcalcsset', {
    name: 'ViewExtractSkipCalcsSet',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'Skip', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['viewextractskiprulevaluesset', {
    name: 'ViewExtractSkipRuleValuesSet',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'Skip', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['viewextractskipzeroesset', {
    name: 'ViewExtractSkipZeroesSet',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'Skip', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['viewextractskipconsolidatedvaluesset', {
    name: 'ViewExtractSkipConsolidatedValuesSet',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'Skip', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['viewgetn', {
    name: 'ViewGetN',
    minParams: 3,
    maxParams: Infinity,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'ElemN', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['viewgets', {
    name: 'ViewGetS',
    minParams: 3,
    maxParams: Infinity,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'ElemN', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['viewputn', {
    name: 'ViewPutN',
    minParams: 4,
    maxParams: Infinity,
    params: [
      { name: 'Value', type: 'numeric' },
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'ElemN', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['viewputs', {
    name: 'ViewPutS',
    minParams: 4,
    maxParams: Infinity,
    params: [
      { name: 'Value', type: 'string' },
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'ElemN', type: 'string' },
    ],
    returnType: 'void',
  }],

  // ── Security/Client management ────────────────────────────────────────────────
  ['addclient', {
    name: 'AddClient',
    // 1-arg: nur User (Passwort separat via AssignClientPassword). 2-arg: (User, Password).
    minParams: 1,
    maxParams: 2,
    params: [
      { name: 'User', type: 'string' },
      { name: 'Password', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['addclienttogroup', {
    name: 'AddClientToGroup',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'User', type: 'string' },
      { name: 'Group', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['addgroup', {
    name: 'AddGroup',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'Group', type: 'string' }],
    returnType: 'void',
  }],
  ['assignclientpassword', {
    name: 'AssignClientPassword',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'User', type: 'string' },
      { name: 'Password', type: 'string' },
    ],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['deleteclient', {
    name: 'DeleteClient',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'User', type: 'string' }],
    returnType: 'void',
  }],
  ['deletegroup', {
    name: 'DeleteGroup',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'Group', type: 'string' }],
    returnType: 'void',
  }],
  ['removeclientfromgroup', {
    name: 'RemoveClientFromGroup',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'User', type: 'string' },
      { name: 'Group', type: 'string' },
    ],
    returnType: 'void',
  }],

  // ── System/IO functions ───────────────────────────────────────────────────────
  ['fileexists', {
    name: 'FileExists',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'FileName', type: 'string' }],
    returnType: 'numeric',
  }],
  ['asciidelete', {
    name: 'ASCIIDelete',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'FileName', type: 'string' }],
    returnType: 'void',
  }],
  ['odbcopen', {
    name: 'ODBCOpen',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DataSourceName', type: 'string' },
      { name: 'UserName', type: 'string' },
      { name: 'Password', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['odbcclose', {
    name: 'ODBCClose',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'DataSourceName', type: 'string' }],
    returnType: 'void',
  }],
  ['odbcoutput', {
    name: 'ODBCOutput',
    minParams: 3,
    maxParams: Infinity,
    params: [
      { name: 'DataSourceName', type: 'string' },
      { name: 'TableName', type: 'string' },
      { name: 'Value1', type: 'any' },
    ],
    returnType: 'void',
  }],

  // ── ODBC (Task 2) ────────────────────────────────────────────────────────────
  ['odbcinsert', {
    name: 'ODBCInsert',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DataSourceName', type: 'string' },
      { name: 'SQLStatement', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['odbcupdate', {
    name: 'ODBCUpdate',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DataSourceName', type: 'string' },
      { name: 'SQLStatement', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['odbcdelete', {
    name: 'ODBCDelete',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DataSourceName', type: 'string' },
      { name: 'SQLStatement', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['odbcvalue', {
    name: 'ODBCValue',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DataSourceName', type: 'string' },
      { name: 'SQLQuery', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['odbcvaluen', {
    name: 'ODBCValueN',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DataSourceName', type: 'string' },
      { name: 'SQLQuery', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['odbcvalues', {
    name: 'ODBCValueS',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DataSourceName', type: 'string' },
      { name: 'SQLQuery', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['odbcinsertopen', {
    name: 'ODBCInsertOpen',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DataSourceName', type: 'string' },
      { name: 'SQLStatement', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['odbcinsertclose', {
    name: 'ODBCInsertClose',
    minParams: 1,
    maxParams: 1,
    params: [
      { name: 'DataSourceName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['getlasterror', {
    name: 'GetLastError',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'numeric',
  }],
  ['getlasterrormessage', {
    name: 'GetLastErrorMessage',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'string',
  }],
  ['getprocesserrorfiledirectory', {
    name: 'GetProcessErrorFileDirectory',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'string',
  }],
  ['servershutdown', {
    name: 'ServerShutdown',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['setoutputsuppression', {
    name: 'SetOutputSuppression',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'Suppress', type: 'numeric' }],
    returnType: 'void',
  }],
  ['setstatisticaloutput', {
    name: 'SetStatisticalOutput',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'Enable', type: 'numeric' }],
    returnType: 'void',
  }],
  ['batchupdatestart', {
    name: 'BatchUpdateStart',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['processreturncode', {
    name: 'ProcessReturnCode',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'numeric',
  }],

  // ── Process-Control (Task 4) ─────────────────────────────────────────────────
  ['itemreject', {
    name: 'ItemReject',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'ErrorMessage', type: 'string' }],
    returnType: 'void',
  }],
  ['itemskip', {
    name: 'ItemSkip',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'void',
  }],
  ['processbreak', {
    name: 'ProcessBreak',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'void',
  }],
  ['processcontinue', {
    name: 'ProcessContinue',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'void',
  }],
  ['processquit', {
    name: 'ProcessQuit',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'void',
  }],
  ['processerror', {
    name: 'ProcessError',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'void',
  }],
  ['processreturn', {
    name: 'ProcessReturn',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'void',
  }],
  ['processseparator', {
    name: 'ProcessSeparator',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'string',
  }],
  ['processwaittime', {
    name: 'ProcessWaitTime',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'Milliseconds', type: 'numeric' }],
    returnType: 'void',
  }],
  ['rollbackupdates', {
    name: 'RollbackUpdates',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'void',
  }],
  ['forceskipcheck', {
    name: 'ForceSkipCheck',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'void',
  }],
  ['securityoverride', {
    name: 'SecurityOverride',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'void',
  }],
  ['setprologerrorhandling', {
    name: 'SetPrologErrorHandling',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'Mode', type: 'numeric' }],
    returnType: 'void',
  }],
  ['setepilogerrorhandling', {
    name: 'SetEpilogErrorHandling',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'Mode', type: 'numeric' }],
    returnType: 'void',
  }],
  ['setdataerrorhandling', {
    name: 'SetDataErrorHandling',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'Mode', type: 'numeric' }],
    returnType: 'void',
  }],
  ['dataminorerrorcount', {
    name: 'DataMinorErrorCount',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'numeric',
  }],
  ['tm1processerror', {
    name: 'TM1ProcessError',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'ErrorMessage', type: 'string' }],
    returnType: 'void',
  }],

  // ── Datasource Getter/Setter (Task 5) — alle als Assignment `Datasource* = X`
  // or function-call syntax; uniformly modelled as 1-arg functions ──
  ['datasourceasciidecimalseparator', {
    name: 'DatasourceASCIIDecimalSeparator',
    minParams: 1, maxParams: 1,
    params: [{ name: 'Character', type: 'string' }],
    returnType: 'void',
  }],
  ['datasourceasciidelimiter', {
    name: 'DatasourceASCIIDelimiter',
    minParams: 1, maxParams: 1,
    params: [{ name: 'Character', type: 'string' }],
    returnType: 'void',
  }],
  ['datasourceasciiheaderrecords', {
    name: 'DatasourceASCIIHeaderRecords',
    minParams: 1, maxParams: 1,
    params: [{ name: 'Count', type: 'numeric' }],
    returnType: 'void',
  }],
  ['datasourceasciiquotecharacter', {
    name: 'DatasourceASCIIQuoteCharacter',
    minParams: 1, maxParams: 1,
    params: [{ name: 'Character', type: 'string' }],
    returnType: 'void',
  }],
  ['datasourceasciithousandseparator', {
    name: 'DatasourceASCIIThousandSeparator',
    minParams: 1, maxParams: 1,
    params: [{ name: 'Character', type: 'string' }],
    returnType: 'void',
  }],
  ['datasourcecubeview', {
    name: 'DatasourceCubeview',
    minParams: 1, maxParams: 1,
    params: [{ name: 'ViewName', type: 'string' }],
    returnType: 'void',
  }],
  ['datasourcedimensionsubset', {
    name: 'DatasourceDimensionSubset',
    minParams: 1, maxParams: 1,
    params: [{ name: 'SubsetName', type: 'string' }],
    returnType: 'void',
  }],
  ['datasourcenameforclient', {
    name: 'DatasourceNameForClient',
    minParams: 1, maxParams: 1,
    params: [{ name: 'Name', type: 'string' }],
    returnType: 'void',
  }],
  ['datasourcenameforserver', {
    name: 'DatasourceNameForServer',
    minParams: 1, maxParams: 1,
    params: [{ name: 'Name', type: 'string' }],
    returnType: 'void',
  }],
  ['datasourceodbocatalog', {
    name: 'DatasourceODBOCatalog',
    minParams: 1, maxParams: 1,
    params: [{ name: 'Catalog', type: 'string' }],
    returnType: 'void',
  }],
  ['datasourceodboconnectionstring', {
    name: 'DatasourceODBOConnectionString',
    minParams: 1, maxParams: 1,
    params: [{ name: 'ConnectionString', type: 'string' }],
    returnType: 'void',
  }],
  ['datasourceodbocubename', {
    name: 'DatasourceODBOCubeName',
    minParams: 1, maxParams: 1,
    params: [{ name: 'CubeName', type: 'string' }],
    returnType: 'void',
  }],
  ['datasourceodbohierarchyname', {
    name: 'DatasourceODBOHierarchyName',
    minParams: 1, maxParams: 1,
    params: [{ name: 'HierarchyName', type: 'string' }],
    returnType: 'void',
  }],
  ['datasourceodbolocation', {
    name: 'DatasourceODBOLocation',
    minParams: 1, maxParams: 1,
    params: [{ name: 'Location', type: 'string' }],
    returnType: 'void',
  }],
  ['datasourceodboprovider', {
    name: 'DatasourceODBOProvider',
    minParams: 1, maxParams: 1,
    params: [{ name: 'Provider', type: 'string' }],
    returnType: 'void',
  }],
  ['datasourceodbosapclientid', {
    name: 'DatasourceODBOSAPClientID',
    minParams: 1, maxParams: 1,
    params: [{ name: 'ClientID', type: 'string' }],
    returnType: 'void',
  }],
  ['datasourceodbosapclientlanguage', {
    name: 'DatasourceODBOSAPClientLanguage',
    minParams: 1, maxParams: 1,
    params: [{ name: 'Language', type: 'string' }],
    returnType: 'void',
  }],
  ['datasourcepassword', {
    name: 'DatasourcePassword',
    minParams: 1, maxParams: 1,
    params: [{ name: 'Password', type: 'string' }],
    returnType: 'void',
  }],
  ['datasourcequery', {
    name: 'DatasourceQuery',
    minParams: 1, maxParams: 1,
    params: [{ name: 'Query', type: 'string' }],
    returnType: 'void',
  }],
  ['datasourcesapusingroleauths', {
    name: 'DatasourceSAPUsingRoleAuths',
    minParams: 1, maxParams: 1,
    params: [{ name: 'Flag', type: 'numeric' }],
    returnType: 'void',
  }],
  ['datasourcesapusingtexts', {
    name: 'DatasourceSAPUsingTexts',
    minParams: 1, maxParams: 1,
    params: [{ name: 'Flag', type: 'numeric' }],
    returnType: 'void',
  }],
  ['datasourcetype', {
    name: 'DatasourceType',
    minParams: 1, maxParams: 1,
    params: [{ name: 'Type', type: 'string' }],
    returnType: 'void',
  }],
  ['datasourceusername', {
    name: 'DatasourceUsername',
    minParams: 1, maxParams: 1,
    params: [{ name: 'Username', type: 'string' }],
    returnType: 'void',
  }],
  ['tm1user', {
    name: 'TM1User',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'string',
  }],

  // ── Functions no longer available in TM1 / Planning Analytics v12 ─────
  ['addinfocuberestriction', {
    name: 'AddInfoCubeRestriction',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'User', type: 'string' },
      { name: 'Access', type: 'string' },
    ],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['allowexternalrequests', {
    name: 'AllowExternalRequests',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'Allow', type: 'numeric' }],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['associatecamidtogroup', {
    name: 'AssociateCAMIDToGroup',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'CAMID', type: 'string' },
      { name: 'Group', type: 'string' },
    ],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['batchcellincrement', {
    name: 'BatchCellIncrement',
    minParams: 4,
    maxParams: Infinity,
    params: [
      { name: 'Value', type: 'numeric' },
      { name: 'CubeName', type: 'string' },
      { name: 'Elem1', type: 'string' },
      { name: 'ElemN', type: 'string' },
    ],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['batchupdatefinish', {
    name: 'BatchUpdateFinish',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['batchupdatefinishwait', {
    name: 'BatchUpdateFinishWait',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['cgaddpromptvalues', {
    name: 'CGAddPromptValues',
    minParams: 2,
    maxParams: Infinity,
    params: [
      { name: 'CGName', type: 'string' },
      { name: 'Value', type: 'any' },
    ],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['cgpromptgetnextmember', {
    name: 'CGPromptGetNextMember',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'CGName', type: 'string' }],
    returnType: 'string',
    deprecatedInV12: true,
  }],
  ['cgpromptsize', {
    name: 'CGPromptSize',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'CGName', type: 'string' }],
    returnType: 'numeric',
    deprecatedInV12: true,
  }],
  ['createhierarchybyattribute', {
    name: 'CreateHierarchyByAttribute',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'DimName', type: 'string' },
      { name: 'HierName', type: 'string' },
      { name: 'AttrName', type: 'string' },
    ],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['cubedatareservationacquire', {
    name: 'CubeDataReservationAcquire',
    minParams: 3,
    maxParams: Infinity,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'Elem1', type: 'string' },
      { name: 'ElemN', type: 'string' },
    ],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['cubedatareservationget', {
    name: 'CubeDataReservationGet',
    minParams: 3,
    maxParams: Infinity,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'Elem1', type: 'string' },
      { name: 'ElemN', type: 'string' },
    ],
    returnType: 'string',
    deprecatedInV12: true,
  }],
  ['cubedatareservationgetconflicts', {
    name: 'CubeDataReservationGetConflicts',
    minParams: 3,
    maxParams: Infinity,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'Elem1', type: 'string' },
      { name: 'ElemN', type: 'string' },
    ],
    returnType: 'string',
    deprecatedInV12: true,
  }],
  ['cubedatareservationrelease', {
    name: 'CubeDataReservationRelease',
    minParams: 3,
    maxParams: Infinity,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'Elem1', type: 'string' },
      { name: 'ElemN', type: 'string' },
    ],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['cubedatareservationreleaseall', {
    name: 'CubeDataReservationReleaseAll',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'CubeName', type: 'string' }],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['cubesavedata', {
    name: 'CubeSaveData',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'CubeName', type: 'string' }],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['cubesetconnparams', {
    name: 'CubeSetConnParams',
    minParams: 3,
    maxParams: 3,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'Param', type: 'string' },
      { name: 'Value', type: 'string' },
    ],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['cubeunload', {
    name: 'CubeUnload',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'CubeName', type: 'string' }],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['disablebulkloadmode', {
    name: 'DisableBulkLoadMode',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['enablebatchcellincrement', {
    name: 'EnableBatchCellIncrement',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'Enable', type: 'numeric' }],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['enablebulkloadmode', {
    name: 'EnableBulkLoadMode',
    minParams: 0,
    maxParams: 0,
    params: [],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['executecommand', {
    name: 'ExecuteCommand',
    minParams: 1,
    maxParams: 2,
    params: [
      { name: 'Command', type: 'string' },
      { name: 'Wait', type: 'numeric' },
    ],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['executejavan', {
    name: 'ExecuteJavaN',
    minParams: 2,
    maxParams: Infinity,
    params: [
      { name: 'ClassName', type: 'string' },
      { name: 'MethodName', type: 'string' },
    ],
    returnType: 'numeric',
    deprecatedInV12: true,
  }],
  ['executejavas', {
    name: 'ExecuteJavaS',
    minParams: 2,
    maxParams: Infinity,
    params: [
      { name: 'ClassName', type: 'string' },
      { name: 'MethodName', type: 'string' },
    ],
    returnType: 'string',
    deprecatedInV12: true,
  }],
  ['lockoff', {
    name: 'LockOff',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'CubeName', type: 'string' }],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['lockon', {
    name: 'LockOn',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'CubeName', type: 'string' }],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['refreshmdxhierarchy', {
    name: 'RefreshMDXHierarchy',
    minParams: 1,
    maxParams: 2,
    params: [
      { name: 'DimName', type: 'string' },
      { name: 'HierName', type: 'string' },
    ],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['removecamidassociation', {
    name: 'RemoveCAMIDAssociation',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'CAMID', type: 'string' }],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['removecamidassociationfromgroup', {
    name: 'RemoveCAMIDAssociationFromGroup',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'CAMID', type: 'string' },
      { name: 'Group', type: 'string' },
    ],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['setchoreverbosemessages', {
    name: 'SetChoreVerboseMessages',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'Enable', type: 'numeric' }],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['setodbcunicodeinterface', {
    name: 'SetOdbcUnicodeInterface',
    minParams: 1,
    maxParams: 1,
    params: [{ name: 'Enable', type: 'numeric' }],
    returnType: 'void',
    deprecatedInV12: true,
  }],
  ['newdateformatter', {
    name: 'NewDateFormatter',
    minParams: 1,
    maxParams: 6,
    params: [
      { name: 'Locale', type: 'string' },
      { name: 'TimeZone', type: 'string' },
      { name: 'UseUNIXTime', type: 'numeric' },
      { name: 'FormatterStyle', type: 'numeric' },
      { name: 'FormatterType', type: 'numeric' },
      { name: 'TimeType', type: 'numeric' },
    ],
    returnType: 'string',
    performanceNote: {
      recommended: 'prolog',
      reason: 'NewDateFormatter creates a formatter object and should be created only once in the prolog, not per record.',
    },
  }],
  ['swapaliaswithprincipalname', {
    name: 'SwapAliasWithPrincipalName',
    minParams: 2,
    maxParams: 2,
    params: [
      { name: 'DimName', type: 'string' },
      { name: 'AliasAttr', type: 'string' },
    ],
    returnType: 'void',
    deprecatedInV12: true,
  }],

  // ── Task 6a — CubeDR / Data Reservation (5 Fn) ───────────────────────────────
  ['cubedracquire', {
    name: 'CubeDRAcquire',
    minParams: 4, maxParams: 4,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'User', type: 'string' },
      { name: 'BooleanForce', type: 'numeric' },
      { name: 'ElementList', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['cubedrget', {
    name: 'CubeDRGet',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ElementList', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['cubedrgetconflicts', {
    name: 'CubeDRGetConflicts',
    minParams: 1, maxParams: 1,
    params: [{ name: 'CubeName', type: 'string' }],
    returnType: 'string',
  }],
  ['cubedrrelease', {
    name: 'CubeDRRelease',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ElementList', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['cubedrreleaseall', {
    name: 'CubeDRReleaseAll',
    minParams: 1, maxParams: 1,
    params: [{ name: 'CubeName', type: 'string' }],
    returnType: 'void',
  }],

  // ── Task 6b — Cube-Misc (8 Fn) ───────────────────────────────────────────────
  ['addcubedependency', {
    name: 'AddCubeDependency',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'DependentCubeName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['cubedimensioncountget', {
    name: 'CubeDimensionCountGet',
    minParams: 1, maxParams: 1,
    params: [{ name: 'CubeName', type: 'string' }],
    returnType: 'numeric',
  }],
  ['cubeprocessfeeders', {
    name: 'CubeProcessFeeders',
    minParams: 1, maxParams: 1,
    params: [{ name: 'CubeName', type: 'string' }],
    returnType: 'void',
  }],
  ['cuberuleappend', {
    name: 'CubeRuleAppend',
    minParams: 3, maxParams: 3,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'RuleText', type: 'string' },
      { name: 'IsCalculationRule', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['cuberuledestroy', {
    name: 'CubeRuleDestroy',
    minParams: 1, maxParams: 1,
    params: [{ name: 'CubeName', type: 'string' }],
    returnType: 'void',
  }],
  ['cubetimelastupdated', {
    name: 'CubeTimeLastUpdated',
    minParams: 1, maxParams: 1,
    params: [{ name: 'CubeName', type: 'string' }],
    returnType: 'numeric',
  }],
  ['cellsecuritycubecreate', {
    name: 'CellSecurityCubeCreate',
    minParams: 1, maxParams: 1,
    params: [{ name: 'CubeName', type: 'string' }],
    returnType: 'void',
  }],
  ['cellsecuritycubedestroy', {
    name: 'CellSecurityCubeDestroy',
    minParams: 1, maxParams: 1,
    params: [{ name: 'CubeName', type: 'string' }],
    returnType: 'void',
  }],

  // ── Task 6c — Cell-Misc (2 Fn) ───────────────────────────────────────────────
  ['cellincrementn', {
    name: 'CellIncrementN',
    minParams: 3, maxParams: Infinity,
    params: [
      { name: 'Value', type: 'numeric' },
      { name: 'CubeName', type: 'string' },
      { name: 'Elem1', type: 'string' },
      { name: 'ElemN', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['cellputproportionalspread', {
    name: 'CellPutProportionalSpread',
    minParams: 3, maxParams: Infinity,
    params: [
      { name: 'Value', type: 'numeric' },
      { name: 'CubeName', type: 'string' },
      { name: 'Elem1', type: 'string' },
      { name: 'ElemN', type: 'string' },
    ],
    returnType: 'void',
  }],

  // ── Task 6d — Chore-Control (3 Fn) ───────────────────────────────────────────
  ['choreerror', {
    name: 'ChoreError',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'Severity', type: 'string' },
      { name: 'ErrorMessage', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['chorequit', {
    name: 'ChoreQuit',
    minParams: 0, maxParams: 0,
    params: [],
    returnType: 'void',
  }],
  ['chorerollback', {
    name: 'ChoreRollback',
    minParams: 0, maxParams: 0,
    params: [],
    returnType: 'void',
  }],

  // ── Task 6e — Dimension-Direct + Misc (12 Fn) ────────────────────────────────
  ['dimensiondeleteelements', {
    name: 'DimensionDeleteElements',
    minParams: 1, maxParams: 1,
    params: [{ name: 'DimensionName', type: 'string' }],
    returnType: 'void',
  }],
  ['dimensionelementcomponentadddirect', {
    name: 'DimensionElementComponentAddDirect',
    minParams: 4, maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ParentName', type: 'string' },
      { name: 'ChildName', type: 'string' },
      { name: 'Weight', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['dimensionelementcomponentdeletedirect', {
    name: 'DimensionElementComponentDeleteDirect',
    minParams: 3, maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ParentName', type: 'string' },
      { name: 'ChildName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['dimensionelementdeletedirect', {
    name: 'DimensionElementDeleteDirect',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['dimensionelementinsertdirect', {
    name: 'DimensionElementInsertDirect',
    minParams: 5, maxParams: 5,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'InsertionPoint', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'ElementType', type: 'string' },
      { name: 'Weight', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['dimensionelementprincipalname', {
    name: 'DimensionElementPrincipalName',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['dimensionhierarchycreate', {
    name: 'DimensionHierarchyCreate',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'HierarchyName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['dimensiontimelastupdated', {
    name: 'DimensionTimeLastUpdated',
    minParams: 1, maxParams: 1,
    params: [{ name: 'DimensionName', type: 'string' }],
    returnType: 'numeric',
  }],
  ['dimensiontopelementinsert', {
    name: 'DimensionTopElementInsert',
    minParams: 3, maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'ElementType', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['dimensiontopelementinsertdirect', {
    name: 'DimensionTopElementInsertDirect',
    minParams: 3, maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'ElementType', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['dimensionupdatedirect', {
    name: 'DimensionUpdateDirect',
    minParams: 1, maxParams: 1,
    params: [{ name: 'DimensionName', type: 'string' }],
    returnType: 'void',
  }],
  ['deleteallpersistentfeeders', {
    name: 'DeleteAllPersistentFeeders',
    minParams: 0, maxParams: 0,
    params: [],
    returnType: 'void',
  }],

  // ── Task 6f — HTTP (4 Fn) ────────────────────────────────────────────────────
  ['executehttprequest', {
    name: 'ExecuteHttpRequest',
    minParams: 2, maxParams: Infinity,
    params: [
      { name: 'Method', type: 'string' },
      { name: 'URL', type: 'string' },
      { name: 'Option', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['httpresponsegetbody', {
    name: 'HttpResponseGetBody',
    minParams: 0, maxParams: 0,
    params: [],
    returnType: 'string',
  }],
  ['httpresponsegetheader', {
    name: 'HttpResponseGetHeader',
    minParams: 1, maxParams: 1,
    params: [{ name: 'HeaderName', type: 'string' }],
    returnType: 'string',
  }],
  ['httpresponsegetstatuscode', {
    name: 'HttpResponseGetStatusCode',
    minParams: 0, maxParams: 0,
    params: [],
    returnType: 'numeric',
  }],

  // ── Task 6g — MDX / MetaData / OLAP (14 Fn) ──────────────────────────────────
  ['mdxsetexpression', {
    name: 'MDXSetExpression',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'ExpressionName', type: 'string' },
      { name: 'MDXExpression', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['mdxsetexpressionlogical', {
    name: 'MDXSetExpressionLogical',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'ExpressionName', type: 'string' },
      { name: 'MDXExpression', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['mdxsetexpressionnoncalculated', {
    name: 'MDXSetExpressionNonCalculated',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'ExpressionName', type: 'string' },
      { name: 'MDXExpression', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['metadataallrollups', {
    name: 'MetaDataAllRollups',
    minParams: 1, maxParams: 1,
    params: [{ name: 'CubeName', type: 'string' }],
    returnType: 'void',
  }],
  ['metadatarollups', {
    name: 'MetaDataRollups',
    minParams: 1, maxParams: 1,
    params: [{ name: 'CubeName', type: 'string' }],
    returnType: 'void',
  }],
  ['metadatarollupsall', {
    name: 'MetaDataRollupsAll',
    minParams: 1, maxParams: 1,
    params: [{ name: 'CubeName', type: 'string' }],
    returnType: 'void',
  }],
  ['olapcubename', {
    name: 'OLAPCubeName',
    minParams: 0, maxParams: 0,
    params: [],
    returnType: 'string',
  }],
  ['olapdimensionnames', {
    name: 'OLAPDimensionNames',
    minParams: 0, maxParams: 0,
    params: [],
    returnType: 'string',
  }],
  ['olapdimensionproperty', {
    name: 'OLAPDimensionProperty',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'PropertyName', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['olapelementname', {
    name: 'OLAPElementName',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementIndex', type: 'numeric' },
    ],
    returnType: 'string',
  }],
  ['olapelementnames', {
    name: 'OLAPElementNames',
    minParams: 1, maxParams: 1,
    params: [{ name: 'DimensionName', type: 'string' }],
    returnType: 'string',
  }],
  ['olapmemberproperty', {
    name: 'OLAPMemberProperty',
    minParams: 3, maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'PropertyName', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['olaptuplestoodbcinsert', {
    name: 'OLAPTuplesToODBCInsert',
    minParams: 2, maxParams: Infinity,
    params: [
      { name: 'DataSourceName', type: 'string' },
      { name: 'SQLTemplate', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['olaptuplestoodbcupdate', {
    name: 'OLAPTuplesToODBCUpdate',
    minParams: 2, maxParams: Infinity,
    params: [
      { name: 'DataSourceName', type: 'string' },
      { name: 'SQLTemplate', type: 'string' },
    ],
    returnType: 'void',
  }],

  // ── Task 6h — Token / Text (6 Fn) ────────────────────────────────────────────
  ['tokenget', {
    name: 'TokenGet',
    minParams: 3, maxParams: 3,
    params: [
      { name: 'TokenString', type: 'string' },
      { name: 'Delimiter', type: 'string' },
      { name: 'TokenNumber', type: 'numeric' },
    ],
    returnType: 'string',
  }],
  ['tokennum', {
    name: 'TokenNum',
    minParams: 3, maxParams: 3,
    params: [
      { name: 'TokenString', type: 'string' },
      { name: 'Delimiter', type: 'string' },
      { name: 'TokenNumber', type: 'numeric' },
    ],
    returnType: 'numeric',
  }],
  ['tokennumargs', {
    name: 'TokenNumArgs',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'TokenString', type: 'string' },
      { name: 'Delimiter', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['tokenstr', {
    name: 'TokenStr',
    minParams: 3, maxParams: 3,
    params: [
      { name: 'TokenString', type: 'string' },
      { name: 'Delimiter', type: 'string' },
      { name: 'TokenNumber', type: 'numeric' },
    ],
    returnType: 'string',
  }],
  ['tokenstrtype', {
    name: 'TokenStrType',
    minParams: 3, maxParams: 3,
    params: [
      { name: 'TokenString', type: 'string' },
      { name: 'Delimiter', type: 'string' },
      { name: 'TokenNumber', type: 'numeric' },
    ],
    returnType: 'numeric',
  }],
  ['tokentype', {
    name: 'TokenType',
    minParams: 3, maxParams: 3,
    params: [
      { name: 'TokenString', type: 'string' },
      { name: 'Delimiter', type: 'string' },
      { name: 'TokenNumber', type: 'numeric' },
    ],
    returnType: 'numeric',
  }],

  // ── Task 6i — Transaction (7 Fn) ─────────────────────────────────────────────
  ['trandelete', {
    name: 'TranDelete',
    minParams: 1, maxParams: 1,
    params: [{ name: 'TransactionId', type: 'string' }],
    returnType: 'void',
  }],
  ['trangetstatus', {
    name: 'TranGetStatus',
    minParams: 1, maxParams: 1,
    params: [{ name: 'TransactionId', type: 'string' }],
    returnType: 'string',
  }],
  ['tranlogicalopen', {
    name: 'TranLogicalOpen',
    minParams: 0, maxParams: 0,
    params: [],
    returnType: 'string',
  }],
  ['tranopen', {
    name: 'TranOpen',
    minParams: 0, maxParams: 0,
    params: [],
    returnType: 'string',
  }],
  ['transave', {
    name: 'TranSave',
    minParams: 1, maxParams: 1,
    params: [{ name: 'TransactionId', type: 'string' }],
    returnType: 'void',
  }],
  ['transactionlognumrecords', {
    name: 'TransactionLogNumRecords',
    minParams: 0, maxParams: 0,
    params: [],
    returnType: 'numeric',
  }],
  ['transactionresult', {
    name: 'TransactionResult',
    minParams: 0, maxParams: 0,
    params: [],
    returnType: 'string',
  }],

  // ── Task 6j — View-Misc + Subset-Legacy (24 Fn) ──────────────────────────────
  ['subsetaliasget', {
    name: 'SubsetAliasGet',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['subsetaliasset', {
    name: 'SubsetAliasSet',
    minParams: 3, maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'AliasName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['subsetdeleteallelements', {
    name: 'SubsetDeleteAllElements',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['subsetdestroy', {
    name: 'SubsetDestroy',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['subsetelementexists', {
    name: 'SubsetElementExists',
    minParams: 3, maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['subsetelementgetindex', {
    name: 'SubsetElementGetIndex',
    minParams: 3, maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'ElementName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['subsetelementinsert', {
    name: 'SubsetElementInsert',
    minParams: 4, maxParams: 4,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'ElementName', type: 'string' },
      { name: 'Position', type: 'numeric' },
    ],
    returnType: 'void',
  }],
  ['subsetisallset', {
    name: 'SubsetIsAllSet',
    minParams: 3, maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'Flag', type: 'numeric' },
    ],
    returnType: 'numeric',
  }],
  ['subsetmdxget', {
    name: 'SubsetMDXGet',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['subsetmdxset', {
    name: 'SubsetMDXSet',
    minParams: 3, maxParams: 3,
    params: [
      { name: 'DimensionName', type: 'string' },
      { name: 'SubsetName', type: 'string' },
      { name: 'MDXExpression', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['viewcolumndimensionget', {
    name: 'ViewColumnDimensionGet',
    minParams: 3, maxParams: 3,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'Position', type: 'numeric' },
    ],
    returnType: 'string',
  }],
  ['viewcolumndimensionsetget', {
    name: 'ViewColumnDimensionSetGet',
    minParams: 3, maxParams: 3,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'Position', type: 'numeric' },
    ],
    returnType: 'string',
  }],
  ['viewdestroy', {
    name: 'ViewDestroy',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['viewmdxactivate', {
    name: 'ViewMDXActivate',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['viewmdxdeactivate', {
    name: 'ViewMDXDeActivate',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['viewmdxget', {
    name: 'ViewMDXGet',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['viewmdxset', {
    name: 'ViewMDXSet',
    minParams: 3, maxParams: 3,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'MDXExpression', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['viewrowdimensionget', {
    name: 'ViewRowDimensionGet',
    minParams: 3, maxParams: 3,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'Position', type: 'numeric' },
    ],
    returnType: 'string',
  }],
  ['viewrowdimensionsetget', {
    name: 'ViewRowDimensionSetGet',
    minParams: 3, maxParams: 3,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'Position', type: 'numeric' },
    ],
    returnType: 'string',
  }],
  ['viewstructcompact', {
    name: 'ViewStructCompact',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['viewstructupdate', {
    name: 'ViewStructUpdate',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['viewsubsetget', {
    name: 'ViewSubsetGet',
    minParams: 3, maxParams: 3,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'DimensionName', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['viewzerosuppressionget', {
    name: 'ViewZeroSuppressionGet',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
    ],
    returnType: 'numeric',
  }],
  ['viewzerosuppressionset', {
    name: 'ViewZeroSuppressionSet',
    minParams: 3, maxParams: 3,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
      { name: 'SuppressZeroes', type: 'numeric' },
    ],
    returnType: 'void',
  }],

  // ── Task 6k — Sonstige (18 Fn) ───────────────────────────────────────────────
  ['assignclienttogroup', {
    name: 'AssignClientToGroup',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'ClientName', type: 'string' },
      { name: 'GroupName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['asciioutputopen', {
    name: 'AsciiOutputOpen',
    minParams: 1, maxParams: 1,
    params: [{ name: 'FileName', type: 'string' }],
    returnType: 'void',
  }],
  ['canceljobs', {
    name: 'CancelJobs',
    minParams: 0, maxParams: 0,
    params: [],
    returnType: 'void',
  }],
  ['disablemtqviewconstruct', {
    name: 'DisableMTQViewConstruct',
    minParams: 0, maxParams: 0,
    params: [],
    returnType: 'void',
  }],
  ['enablemtqviewconstruct', {
    name: 'EnableMTQViewConstruct',
    minParams: 0, maxParams: 0,
    params: [],
    returnType: 'void',
  }],
  ['formatdate', {
    name: 'FormatDate',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'SerialDate', type: 'numeric' },
      { name: 'FormatString', type: 'string' },
    ],
    returnType: 'string',
  }],
  ['getjobstatus', {
    name: 'GetJobStatus',
    minParams: 1, maxParams: 1,
    params: [{ name: 'JobId', type: 'string' }],
    returnType: 'string',
  }],
  ['getprocesserrorfilename', {
    name: 'GetProcessErrorFilename',
    minParams: 0, maxParams: 0,
    params: [],
    returnType: 'string',
  }],
  ['getuseactivesandboxproperty', {
    name: 'GetUseActiveSandboxProperty',
    minParams: 0, maxParams: 0,
    params: [],
    returnType: 'numeric',
  }],
  ['levelcount', {
    name: 'LevelCount',
    minParams: 1, maxParams: 1,
    params: [{ name: 'DimensionName', type: 'string' }],
    returnType: 'numeric',
  }],
  ['sleep', {
    name: 'Sleep',
    minParams: 1, maxParams: 1,
    params: [{ name: 'Milliseconds', type: 'numeric' }],
    returnType: 'void',
  }],
  ['sys', {
    name: 'SYS',
    minParams: 0, maxParams: 0,
    params: [],
    returnType: 'string',
  }],
  ['tm1message', {
    name: 'TM1Message',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'Severity', type: 'string' },
      { name: 'Message', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['tmpnameget', {
    name: 'TMPNameGet',
    minParams: 0, maxParams: 0,
    params: [],
    returnType: 'string',
  }],
  ['tmpnamegetex', {
    name: 'TMPNameGetEx',
    minParams: 1, maxParams: 1,
    params: [{ name: 'Prefix', type: 'string' }],
    returnType: 'string',
  }],
  ['trace', {
    name: 'TRACE',
    minParams: 1, maxParams: 1,
    params: [{ name: 'Message', type: 'string' }],
    returnType: 'void',
  }],
  ['value', {
    name: 'VALUE',
    minParams: 1, maxParams: 1,
    params: [{ name: 'StringValue', type: 'string' }],
    returnType: 'numeric',
  }],
  ['valuepmt', {
    name: 'VALUEPMT',
    minParams: 5, maxParams: 5,
    params: [
      { name: 'Rate', type: 'numeric' },
      { name: 'NumberOfPeriods', type: 'numeric' },
      { name: 'PresentValue', type: 'numeric' },
      { name: 'FutureValue', type: 'numeric' },
      { name: 'PaymentType', type: 'numeric' },
    ],
    returnType: 'numeric',
  }],
  ['viewzeroout', {
    name: 'ViewZeroOut',
    minParams: 2, maxParams: 2,
    params: [
      { name: 'CubeName', type: 'string' },
      { name: 'ViewName', type: 'string' },
    ],
    returnType: 'void',
  }],
  ['parsedate', {
    name: 'ParseDate',
    minParams: 1, maxParams: 3,
    params: [
      { name: 'DateString', type: 'string' },
      { name: 'Pattern', type: 'string' },
      { name: 'Index', type: 'numeric' },
    ],
    returnType: 'numeric',
  }],
  ['numbertostringex', {
    name: 'NumberToStringEx',
    minParams: 4, maxParams: 4,
    params: [
      { name: 'Number', type: 'numeric' },
      { name: 'FormatString', type: 'string' },
      { name: 'DecimalSeparator', type: 'string' },
      { name: 'ThousandsSeparator', type: 'string' },
    ],
    returnType: 'string',
  }],
]);
