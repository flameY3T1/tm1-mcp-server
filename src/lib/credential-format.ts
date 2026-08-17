/**
 * What a datasource password exported from TM1 actually is — the answer differs
 * per major version, and a boolean "credentials included" flag cannot express
 * it. Measured 2026-08-17 against 11.8.02900.8 and a v12 database:
 *
 * - v11 returns a ciphertext bound to one *run* of one server. Within a running
 *   instance it is stable — the same cleartext always yields the same value,
 *   across processes — but it is useless on another instance, and measured
 *   2026-08-17 it is equally useless on the same instance after a service
 *   restart: the same password produced three different values across two
 *   restarts, and a value carried across one aborts the process at connect time
 *   with "Unable to open data source". So an exported v11 credential has the
 *   lifetime of the server run it came from. Note this is NOT the encoding TM1
 *   writes into slot 565 of its own Datadir .pro files — that one is longer,
 *   not deterministic even within a run, and cannot be exchanged with this one
 *   in either direction.
 * - v12 returns the plain password, which has no such lifetime.
 */
export type CredentialFormat = "server-encrypted" | "plaintext";

export function credentialFormatFor(version: 11 | 12): CredentialFormat {
  return version === 12 ? "plaintext" : "server-encrypted";
}

/**
 * True when an exported credential is the password itself rather than a
 * server-bound ciphertext — i.e. when writing it to disk leaks a usable secret
 * instead of an instance-local artefact.
 */
export function isPlaintextCredential(version: 11 | 12): boolean {
  return credentialFormatFor(version) === "plaintext";
}
