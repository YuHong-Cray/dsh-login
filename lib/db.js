/**
 * dsh-login — MySQL account-table access (mysql2/promise).
 *
 * The account table (default name `dsh-login`) is created on first use when
 * the connecting user has CREATE privileges on the database:
 *
 *   CREATE TABLE IF NOT EXISTS `dsh-login` (
 *     `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
 *     `username`      VARCHAR(64)  NOT NULL,
 *     `password_hash` VARCHAR(255) NOT NULL,   -- scrypt verifier, never plain text
 *     `status`        VARCHAR(16)  NOT NULL DEFAULT 'approved',
 *                                              -- approved | pending | rejected
 *     `model_self_service` TINYINT(1) NOT NULL DEFAULT 0,
 *                                              -- 1 = may configure their own model providers
 *     `created_at`    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
 *     `last_login_at` TIMESTAMP    NULL DEFAULT NULL,
 *     PRIMARY KEY (`id`),
 *     UNIQUE KEY `uk_dsh_login_username` (`username`)
 *   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
 *
 * `status` was added later, so `ensureTable()` also migrates an existing table
 * with `ALTER TABLE ... ADD COLUMN ... DEFAULT 'approved'`: rows that predate
 * the approval workflow stay usable instead of being locked out.
 * `model_self_service` is migrated the same way, with DEFAULT 0: a user who
 * predates the switch starts DENIED (the administrator grants self-service
 * explicitly), the safe direction for an upgrade. The hub mirrors the column
 * into the user's DSH_HOME so their instance can enforce it without a database
 * (see lib/model-policy.js).
 *
 * All user input travels through prepared-statement placeholders. The table
 * name comes from the deployment config and is validated against
 * ^[A-Za-z0-9_]+$ before interpolation.
 */
import mysql from 'mysql2/promise'

const ERR_DUP_ENTRY = 1062
const ERR_NO_DB = 1049
const ERR_ACCESS_DENIED = 1045
const ERR_UNKNOWN_USER = 1045

/** Every account status the approval workflow understands. */
export const ACCOUNT_STATUSES = ['approved', 'pending', 'rejected']

const ERRORS_WORTH_SHOWING = new Set([ERR_DUP_ENTRY, ERR_NO_DB, ERR_ACCESS_DENIED, ERR_UNKNOWN_USER])

/**
 * One lazily-created connection pool bound to the configured database.
 * Methods throw Error with a `db-down` tag when the database is unreachable
 * so the HTTP layer can answer 503 with a friendly message.
 */
export class LoginDatabase {
  /**
   * @param cfg - normalized db config: host, port, user, password, database, table.
   */
  constructor(cfg) {
    this.cfg = { ...cfg }
    if (!/^[A-Za-z0-9_-]+$/.test(this.cfg.table)) {
      throw new Error(`dsh-login: db.table must match ^[A-Za-z0-9_-]+$ (got ${JSON.stringify(cfg.table)})`)
    }
    this.pool = undefined
    this.lastError = ''
  }

  /** The quoted table identifier for SQL statements. */
  table() {
    return `\`${this.cfg.table}\``
  }

  poolInstance() {
    if (this.pool === undefined) {
      this.pool = mysql.createPool({
        host: this.cfg.host,
        port: this.cfg.port,
        user: this.cfg.user,
        password: this.cfg.password,
        database: this.cfg.database,
        waitForConnections: true,
        connectionLimit: 4,
        connectTimeout: 8000,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10_000,
      })
    }
    return this.pool
  }

  /**
   * Ensure the account table exists.
   * @returns the table name.
   * @throws {Error} tagged db-down when the database is unreachable.
   */
  async ensureTable() {
    const t = this.table()
    try {
      await this.poolInstance().query(
        `CREATE TABLE IF NOT EXISTS ${t} (
           id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
           username      VARCHAR(64)  NOT NULL,
           password_hash VARCHAR(255) NOT NULL,
           status        VARCHAR(16)  NOT NULL DEFAULT 'approved',
           model_self_service TINYINT(1) NOT NULL DEFAULT 0,
           created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
           last_login_at TIMESTAMP    NULL DEFAULT NULL,
           PRIMARY KEY (id),
           UNIQUE KEY uk_username (username)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      )
      await this.ensureStatusColumn()
      await this.ensureModelSelfServiceColumn()
      this.lastError = ''
      return this.cfg.table
    } catch (err) {
      this.lastError = err.message
      throw this.down(err)
    }
  }

  /**
   * Add `status` to a table that predates the approval workflow.
   * The column DEFAULT is 'approved', so rows created earlier keep working
   * instead of locking their owners out after an upgrade.
   * @returns true when the column was added by this call.
   */
  async ensureStatusColumn() {
    const t = this.table()
    const [rows] = await this.poolInstance().query(`SHOW COLUMNS FROM ${t} LIKE 'status'`)
    if (Array.isArray(rows) && rows.length > 0) return false
    await this.poolInstance().query(
      `ALTER TABLE ${t} ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'approved'`,
    )
    return true
  }

  /**
   * Add `model_self_service` to a table that predates the self-service switch.
   * The column DEFAULT is 0 (denied): an existing user keeps the old, safer
   * behaviour — an administrator grants self-service explicitly — instead of
   * silently gaining the right to add providers after an upgrade.
   * @returns true when the column was added by this call.
   */
  async ensureModelSelfServiceColumn() {
    const t = this.table()
    const [rows] = await this.poolInstance().query(`SHOW COLUMNS FROM ${t} LIKE 'model_self_service'`)
    if (Array.isArray(rows) && rows.length > 0) return false
    await this.poolInstance().query(
      `ALTER TABLE ${t} ADD COLUMN model_self_service TINYINT(1) NOT NULL DEFAULT 0`,
    )
    return true
  }

  /**
   * Liveness probe.
   * @returns 'up' or 'down' (never throws).
   */
  async health() {
    try {
      const [rows] = await this.poolInstance().query('SELECT 1')
      this.lastError = ''
      return rows?.length > 0 ? 'up' : 'down'
    } catch (err) {
      this.lastError = err.message
      return 'down'
    }
  }

  /**
   * Insert one account.
   * @param username - validated username.
   * @param passwordHash - scrypt verifier string.
   * @returns {ok:true} or {ok:false, code:'exists'} on the unique-key conflict.
   */
  async register(username, passwordHash, status = 'pending') {
    const t = this.table()
    const safeStatus = ACCOUNT_STATUSES.includes(status) ? status : 'pending'
    try {
      await this.poolInstance().query(
        `INSERT INTO ${t} (username, password_hash, status) VALUES (?, ?, ?)`,
        [username, passwordHash, safeStatus],
      )
      return { ok: true, status: safeStatus }
    } catch (err) {
      if (err?.code === ERR_DUP_ENTRY || err?.errno === ERR_DUP_ENTRY) {
        return { ok: false, code: 'exists' }
      }
      this.lastError = err.message
      throw this.down(err)
    }
  }

  /**
   * Fetch the stored verifier for one username.
   * @returns the row ({username, password_hash, status, model_self_service})
   *   or undefined when absent.
   */
  async findByUsername(username) {
    const t = this.table()
    try {
      const [rows] = await this.poolInstance().query(
        `SELECT username, password_hash, status, model_self_service FROM ${t} WHERE username = ? LIMIT 1`,
        [username],
      )
      return rows?.[0]
    } catch (err) {
      this.lastError = err.message
      throw this.down(err)
    }
  }

  /**
   * List all accounts (management page).
   * @returns [{username, created_at, last_login_at, status, model_self_service}]
   *   ordered by username.
   */
  async listUsers() {
    const t = this.table()
    try {
      const [rows] = await this.poolInstance().query(
        `SELECT username, created_at, last_login_at, status, model_self_service FROM ${t} ORDER BY username`,
      )
      return rows
    } catch (err) {
      this.lastError = err.message
      throw this.down(err)
    }
  }

  /**
   * Set one account's approval status (administrator action).
   * @param username - the account name.
   * @param status - one of {@link ACCOUNT_STATUSES}.
   * @returns `{ok: true, changed}`; `changed` is 0 when the value was already set.
   * @throws Error when `status` is unknown or the database is unreachable.
   */
  async setStatus(username, status) {
    if (!ACCOUNT_STATUSES.includes(status)) {
      throw new Error(`dsh-login: unknown account status ${JSON.stringify(status)}`)
    }
    const t = this.table()
    try {
      const [result] = await this.poolInstance().query(
        `UPDATE ${t} SET status = ? WHERE username = ?`,
        [status, username],
      )
      return { ok: true, changed: result?.affectedRows ?? 0 }
    } catch (err) {
      this.lastError = err.message
      throw this.down(err)
    }
  }

  /**
   * Grant or revoke one account's right to configure its own model providers
   * (administrator action on the user-management console).
   *
   * The hub mirrors this decision into the user's DSH_HOME
   * (lib/model-policy.js) so their instance enforces it without a database.
   * @param username - the account name.
   * @param allow - true to allow self-service, false to require an administrator.
   * @returns `{ok: true, changed}`; `changed` is 0 when the value was already set.
   * @throws Error when the database is unreachable.
   */
  async setModelSelfService(username, allow) {
    const t = this.table()
    try {
      const [result] = await this.poolInstance().query(
        `UPDATE ${t} SET model_self_service = ? WHERE username = ?`,
        [allow === true ? 1 : 0, username],
      )
      return { ok: true, changed: result?.affectedRows ?? 0 }
    } catch (err) {
      this.lastError = err.message
      throw this.down(err)
    }
  }

  /** Record a successful login (best effort; failures never block login). */
  async touchLastLogin(username) {
    const t = this.table()
    try {
      await this.poolInstance().query(
        `UPDATE ${t} SET last_login_at = NOW() WHERE username = ?`,
        [username],
      )
    } catch (err) {
      this.lastError = err.message
    }
  }

  /** Drop one account (maintenance path; also used by the test suite). */
  async remove(username) {
    const t = this.table()
    try {
      const [result] = await this.poolInstance().query(`DELETE FROM ${t} WHERE username = ?`, [username])
      return result?.affectedRows ?? 0
    } catch (err) {
      this.lastError = err.message
      throw this.down(err)
    }
  }

  close() {
    if (this.pool !== undefined) {
      const pool = this.pool
      this.pool = undefined
      void pool.end().catch(() => {})
    }
  }

  down(err) {
    const cause = err instanceof Error ? err : new Error(String(err))
    const tagged = new Error(`database unavailable: ${cause.message}`)
    tagged.dbDown = true
    tagged.cause = cause
    return tagged
  }
}

export { ERRORS_WORTH_SHOWING }
