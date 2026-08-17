/**
 * Whether exporting a datasource password to a file is worth offering at all,
 * which turns on what the REST API actually hands out. Measured 2026-08-17
 * against 11.8.02900.8 and a v12 database:
 *
 * - v11 returns a ciphertext bound to one *run* of one server. Within a running
 *   instance it is stable — the same cleartext yields the same value across
 *   processes — but it is useless on another instance, and equally useless on
 *   the same instance after a service restart: the same password produced three
 *   different values across two restarts, and a value carried across one aborts
 *   the process at connect time with "Unable to open data source". Nothing
 *   fixes that from our side, because the durable form (slot 565 of TM1's own
 *   Datadir .pro, a longer encoding that is not even deterministic within a run)
 *   is never exposed over REST.
 * - v12 returns the plain password, which has no such lifetime.
 *
 * So a v11 export can only carry a credential through a window in which
 * tm1_copy_process would have worked anyway, and fails silently outside it —
 * the file still looks complete. Export therefore refuses on v11 and points at
 * tm1_copy_process (to clone now) or dataSourcePassword (to deploy later).
 */
export function supportsCredentialExport(version: 11 | 12): boolean {
  return version === 12;
}
