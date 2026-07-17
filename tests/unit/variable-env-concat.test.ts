import { describe, it, expect } from 'vitest';
import { resolveExpression, buildProcessEnv, type ProcessEnv } from '../../src/lib/callgraph/variableEnv.js';
import { buildReferenceIndex } from '../../src/lib/callgraph/referenceIndex.js';

const emptyEnv = (): ProcessEnv => ({
  paramsLc: new Set(),
  paramOriginal: new Map(),
  paramTypes: new Map(),
  datasourceVars: new Map(),
  vars: new Map(),
});

describe('resolveExpression — constant concat folding', () => {
  it('folds two string literals', () => {
    expect(resolveExpression("'te' | 'st'", emptyEnv())).toEqual({ kind: 'literal', value: 'test' });
  });
  it('folds three literals', () => {
    expect(resolveExpression("'z' | 'A' | 'B'", emptyEnv())).toEqual({ kind: 'literal', value: 'zAB' });
  });
  it('folds literal concatenated with numeric literal', () => {
    expect(resolveExpression("'v' | 42", emptyEnv())).toEqual({ kind: 'literal', value: 'v42' });
  });
  it('folds a literal concatenated with a bound literal variable', () => {
    const env = emptyEnv();
    env.vars.set('sother', { kind: 'literal', value: 'B' });
    expect(resolveExpression("'zA' | sOther", env)).toEqual({ kind: 'literal', value: 'zAB' });
  });
  it('stays dynamic when one operand is an unknown identifier', () => {
    expect(resolveExpression("'zA' | sOther", emptyEnv())).toEqual({ kind: 'dynamic' });
  });
  it('does not split a pipe inside a string literal', () => {
    expect(resolveExpression("'a|b'", emptyEnv())).toEqual({ kind: 'literal', value: 'a|b' });
  });
  it('does not split a pipe inside parens', () => {
    expect(resolveExpression("FOO('a|b')", emptyEnv())).toEqual({ kind: 'dynamic' });
  });
  it('stays dynamic on malformed empty operand', () => {
    expect(resolveExpression("'a' | | 'b'", emptyEnv())).toEqual({ kind: 'dynamic' });
  });
});

describe('buildReferenceIndex — constant-concat call resolves edge', () => {
  it('resolves ExecuteProcess(concat) to a real edge, not unresolved', async () => {
    const index = await buildReferenceIndex({
      fetchProcesses: async () => [
        { name: 'P', prolog: "sProc = 'zA' | 'zB';\nExecuteProcess(sProc);", metadata: '', data: '', epilog: '', parameters: [] },
      ],
      fetchCubesWithRules: async () => [],
      fetchChores: async () => [],
    });
    expect(
      index.bySourceProcess.get('p')?.some((r) => r.targetKind === 'process' && r.targetName === 'zAzB'),
    ).toBe(true);
    expect(index.unresolvedCallsBySourceProcess.get('p')).toBeUndefined();
  });
});
