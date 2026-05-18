/**
 * Shared predicate for TM1 control objects.
 *
 * IBM Planning Analytics names every server-internal object with a `}` prefix
 * (e.g., `}ClientProperties`, `}tp_*`). All audit/listing tools filter these
 * out by default, so the rule lives here instead of being re-implemented
 * per tool.
 */
export const isControlName = (name: string): boolean => name.startsWith("}");
