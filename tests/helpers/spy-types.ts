import type { Mock } from "vitest";

/**
 * Type for a bare `vi.fn()` used as a function spy (fetch stubs, injected
 * callbacks).
 *
 * The shape this replaces — `ReturnType` of the bare `vi.fn` — resolves to
 * `Mock<Procedure | Constructable>`, a union with the *constructor* overload.
 * A fetch stub is never called with `new`, and the union makes TypeScript pick
 * a signature whose return is treated as `void`: every
 * `mockImplementation(() => Promise.resolve(...))` then looks like a promise
 * discarded in a void context, which is what `no-misused-promises` reports.
 * Narrowing to the call signature removes both the false report and the hole
 * that hid what the spy actually returns.
 *
 * `any` here matches vitest's own `Procedure`: spies are handed
 * implementations with wildly different arities and parameter types, and
 * `unknown[]` parameters would reject every one of them under
 * `strictFunctionTypes`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FnSpy = Mock<(...args: any[]) => any>;
