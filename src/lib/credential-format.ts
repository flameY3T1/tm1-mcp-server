/**
 * What a datasource password exported from TM1 actually is — the answer differs
 * per major version, and a boolean "credentials included" flag cannot express
 * it. Measured 2026-08-17 against 11.8.02900.8 and a v12 database:
 *
 * - v11 returns a ciphertext bound to that server. It is deterministic per
 *   instance (the same cleartext always yields the same value) but useless on
 *   another instance, which decrypts it to garbage. Note this is NOT the same
 *   encoding TM1 writes into slot 565 of its own Datadir .pro files — that one
 *   is a longer, non-deterministic representation and cannot be exchanged with
 *   this one in either direction.
 * - v12 returns the plain password.
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
