/**
 * dsh-login — the account approval statuses, shared by every storage driver.
 *
 * Kept in its own module (no driver imports, no dependencies) so a SQLite-only
 * deployment never pulls `mysql2` just to compare a status string.
 */

/** Every account status the approval workflow understands. */
export const ACCOUNT_STATUSES = ['approved', 'pending', 'rejected']
