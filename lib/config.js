/**
 * dsh-login — deployment configuration ($DSH_HOME/dsh-login.json).
 *
 * Two deployment modes share one code base, selected by the config:
 *
 *   hub      (default) — the login surface on the operator's dsh web. Carries
 *         the account-table database connection, the network/session policy,
 *         the admin account list, and the per-user instance settings. On a
 *         successful login/registration a regular user is handed off to their
 *         own dedicated dsh web instance.
 *
 *   instance — one dedicated per-user dsh web. No database, no session store:
 *         it accepts a short-lived handoff token from the hub (minted with the
 *         shared browser-session secret) to issue the built-in browser cookie,
 *         then behaves as the network gate for that user's environment. The
 *         hub writes each instance's dsh-login.json in this shape.
 *
 * The config is deployment-local state: a 0600 file inside the Harness home,
 * never part of the plugin source. A missing file or invalid values fail
 * plugin activation loudly rather than guessing a connection.
 *
 * The one thing that is NOT required is a database: `normalizeDb()` resolves the
 * account store to MySQL when `db.host`/`db.user`/`db.database` are configured
 * and to a SQLite file under DSH_HOME otherwise (see lib/db-sqlite.js), so a
 * bare `dsh-login.json` with just the network policy is a complete deployment.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const DEFAULT_CONFIG = {
  db: {
    // 'auto' (default): MySQL when db.host/db.user/db.database are configured,
    // otherwise the built-in SQLite store — a deployment with no database still
    // works end to end. Set 'mysql' or 'sqlite' to pin the backend explicitly.
    driver: 'auto',
    table: 'dsh_login',
    // MySQL backend (required when the driver resolves to mysql).
    host: '127.0.0.1',
    port: 3306,
    user: '',
    password: '',
    database: '',
    // SQLite backend: '' = <DSH_HOME>/dsh-login-accounts.sqlite (created on
    // first use, 0600). An absolute path may be given.
    file: '',
  },
  allowCidrs: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
  rejectProxyHeaders: true,
  sessionTtlSec: 7 * 24 * 3600,
  register: 'open',
  // New self-registered accounts wait for an administrator to approve them.
  requireApproval: true,
  adminUsers: [],
  instances: {
    root: '/srv/dsh-users',
    portBase: 3100,
    checkout: '/deepseek-harness',
    isolation: 'uid',
    osUserPrefix: 'dsh-',
    maxOldSpaceMb: 1536,
    nprocLimit: 512,
  },
}

export const INSTANCE_DEFAULTS = {
  handoffTtlSec: 10 * 60,
}

/** Character set for user names (mirrors the login username rules). */
const USERNAME_PATTERN = /^[\u4e00-\u9fff\u3400-\u4dbfA-Za-z0-9._-]+$/

export function configPath(dshHome) {
  return `${dshHome}/dsh-login.json`
}

/**
 * Read and validate the deployment config.
 * @param dshHome - the Harness home directory.
 * @returns the normalized config object (carries a `mode` field).
 * @throws when the file is missing, unparseable, or incomplete.
 */
export function loadConfig(dshHome) {
  const path = configPath(dshHome)
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(`dsh-login: ${path} is missing; write the deployment config (see vendor/dsh-login/README.md) and restart dsh web`)
    }
    throw err
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`dsh-login: ${path} is not valid JSON: ${err.message}`)
  }
  return normalizeConfig(parsed, dshHome)
}

/** Write a fresh config file (0600) with explicit deployment values. */
export function saveConfig(dshHome, config) {
  const normalized = normalizeConfig(config, dshHome)
  const path = configPath(dshHome)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 })
  return normalized
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readUrl(value, label) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`dsh-login: ${label} must be an http(s) URL string`)
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`dsh-login: ${label} is not a valid URL: ${JSON.stringify(value)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`dsh-login: ${label} must use http or https (got ${parsed.protocol})`)
  }
  return `${parsed.protocol}//${parsed.host}/`
}

function readCidrs(input, label = 'allowCidrs') {
  if (Array.isArray(input.allowCidrs) && input.allowCidrs.length > 0) {
    return input.allowCidrs.map(String)
  }
  return [...DEFAULT_CONFIG.allowCidrs]
}

/** Default SQLite file name inside a hub's DSH_HOME (mirrors lib/db-sqlite.js). */
const SQLITE_DEFAULT_FILE = 'dsh-login-accounts.sqlite'

/**
 * Resolve which account store this deployment uses.
 *
 *   db absent / no MySQL fields  → SQLite under DSH_HOME, created on first use.
 *       A deployment with no database at all still completes the whole flow
 *       (register → approval → login → per-user instance), which is the point:
 *       MySQL is an option, not a prerequisite.
 *   db.host + db.user + db.database → MySQL (the shared/enterprise table).
 *   db.driver 'mysql' | 'sqlite'    → pin the backend explicitly.
 *
 * A half-configured MySQL block (any one of host/user/database present) is a
 * hard error rather than a silent fallback: auto-switching to SQLite there would
 * split the accounts away from the shared table the operator was trying to
 * reach, and the first login would look like a missing account.
 * @param input - the raw `db` value (absent = `{}`).
 * @param dshHome - Harness home for the default SQLite path (optional).
 * @returns the normalized `db` config (`driver` plus its fields).
 */
function normalizeDb(input, dshHome) {
  const db = isRecord(input) ? input : {}
  const table = typeof db.table === 'string' && db.table !== '' ? db.table : DEFAULT_CONFIG.db.table
  // The identifier is interpolated into SQL (backtick-quoted for MySQL,
  // double-quoted for SQLite); the character-set ban is the injection guard.
  if (!/^[A-Za-z0-9_-]+$/.test(table)) {
    throw new Error(`dsh-login: db.table must match ^[A-Za-z0-9_-]+$ (got ${JSON.stringify(table)})`)
  }
  const driver = db.driver === undefined ? DEFAULT_CONFIG.db.driver : String(db.driver)
  if (driver !== 'auto' && driver !== 'mysql' && driver !== 'sqlite') {
    throw new Error(`dsh-login: db.driver must be "mysql", "sqlite" or "auto" (got ${JSON.stringify(db.driver)})`)
  }
  const host = typeof db.host === 'string' ? db.host.trim() : ''
  const user = typeof db.user === 'string' ? db.user : ''
  const database = typeof db.database === 'string' ? db.database : ''
  const mysqlConfigured = host !== '' || user !== '' || database !== ''
  if (driver === 'sqlite' || (driver === 'auto' && !mysqlConfigured)) {
    const file = typeof db.file === 'string' ? db.file.trim() : ''
    if (file !== '' && !isAbsolute(file)) {
      throw new Error(`dsh-login: db.file must be an absolute path (got ${JSON.stringify(db.file)})`)
    }
    const home = typeof dshHome === 'string' && dshHome !== '' ? resolve(dshHome) : process.cwd()
    return { driver: 'sqlite', file: file === '' ? join(home, SQLITE_DEFAULT_FILE) : file, table }
  }
  const port = db.port === undefined ? DEFAULT_CONFIG.db.port : Number(db.port)
  const password = db.password === undefined ? '' : db.password
  if (host === '' || user === '' || database === '') {
    throw new Error(
      'dsh-login: db.host, db.user and db.database are required once the MySQL backend is selected '
      + `(db.driver=${driver}); set db.driver to "sqlite" — or drop the db block — to use the built-in SQLite account store`,
    )
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`dsh-login: db.port must be an integer 1-65535 (got ${JSON.stringify(db.port)})`)
  }
  if (typeof password !== 'string') {
    throw new Error('dsh-login: db.password must be a string')
  }
  return { driver: 'mysql', host, port, user, password, database, table }
}

/**
 * Validate one parsed config object and fill defaults.
 * @param input - the raw parsed JSON.
 * @param dshHome - the Harness home, used to resolve the default SQLite file
 *   path. Optional: callers that only normalize a bare object (tests, the
 *   instance writer) leave it out and keep `db.file` unresolved.
 * @returns the normalized config object.
 */
export function normalizeConfig(input, dshHome) {
  if (!isRecord(input)) throw new Error('dsh-login: config must be a JSON object')

  // ---- instance mode: one dedicated per-user dsh web ----------------------
  if (input.instance === true) {
    return {
      mode: 'instance',
      instance: true,
      port: normalizeInstancePort(input.port),
      hubBase: readUrl(input.hubBase, 'hubBase'),
      handoffTtlSec: normalizeHandoffTtl(input.handoffTtlSec),
      allowCidrs: readCidrs(input),
      rejectProxyHeaders: input.rejectProxyHeaders === undefined ? true : Boolean(input.rejectProxyHeaders),
    }
  }
  if (input.instance !== undefined && input.instance !== false) {
    throw new Error('dsh-login: "instance" must be true in instance mode; omit it for hub mode')
  }

  // ---- hub mode -----------------------------------------------------------
  const db = normalizeDb(input.db, dshHome)
  const sessionTtlSec = input.sessionTtlSec === undefined ? DEFAULT_CONFIG.sessionTtlSec : Number(input.sessionTtlSec)
  if (!Number.isInteger(sessionTtlSec) || sessionTtlSec < 60 || sessionTtlSec > 365 * 24 * 3600) {
    throw new Error('dsh-login: sessionTtlSec must be an integer between 60 and 31536000')
  }
  const register = input.register === undefined ? 'open' : input.register
  if (register !== 'open' && register !== 'disabled') {
    throw new Error(`dsh-login: register must be "open" or "disabled" (got ${JSON.stringify(register)})`)
  }
  // A new registration is created 'pending' unless approval is switched off.
  // Accepts real booleans (JSON config) and the YAML-ish strings true/false.
  const requireApprovalRaw = input.requireApproval
  if (requireApprovalRaw !== undefined
    && typeof requireApprovalRaw !== 'boolean'
    && requireApprovalRaw !== 'true' && requireApprovalRaw !== 'false') {
    throw new Error(`dsh-login: requireApproval must be a boolean (got ${JSON.stringify(requireApprovalRaw)})`)
  }
  const requireApproval = requireApprovalRaw === undefined
    ? DEFAULT_CONFIG.requireApproval
    : requireApprovalRaw === true || requireApprovalRaw === 'true'

  const adminUsers = Array.isArray(input.adminUsers)
    ? input.adminUsers.map(String).filter((name) => {
        if (name.length < 2 || name.length > 32 || !USERNAME_PATTERN.test(name)) {
          throw new Error(`dsh-login: adminUsers entry is not a valid username: ${JSON.stringify(name)}`)
        }
        return true
      })
    : []

  const instancesIn = isRecord(input.instances) ? input.instances : {}
  const rootRaw = instancesIn.root === undefined ? DEFAULT_CONFIG.instances.root : String(instancesIn.root)
  if (!isAbsolute(rootRaw)) {
    throw new Error(`dsh-login: instances.root must be an absolute path (got ${JSON.stringify(rootRaw)})`)
  }
  const portBase = instancesIn.portBase === undefined ? DEFAULT_CONFIG.instances.portBase : Number(instancesIn.portBase)
  if (!Number.isInteger(portBase) || portBase < 1024 || portBase > 65000) {
    throw new Error(`dsh-login: instances.portBase must be an integer 1024-65000 (got ${JSON.stringify(instancesIn.portBase)})`)
  }
  const checkoutRaw = instancesIn.checkout === undefined ? DEFAULT_CONFIG.instances.checkout : String(instancesIn.checkout)
  if (!isAbsolute(checkoutRaw)) {
    throw new Error(`dsh-login: instances.checkout must be an absolute path (got ${JSON.stringify(checkoutRaw)})`)
  }
  // Optional in hub mode: when absent or empty the hub derives it at
  // runtime from its own non-loopback IP and listen port.
  const hubBase = instancesIn.hubBase === undefined || instancesIn.hubBase === ''
    ? ''
    : readUrl(instancesIn.hubBase, 'instances.hubBase')

  // Per-tenant OS isolation. 'uid' (default) runs every instance as its own
  // non-root account with the DSH_HOME handed to that uid; 'none' keeps the
  // legacy root-mode instances and is single-tenant / development only.
  const isolation = instancesIn.isolation === undefined ? DEFAULT_CONFIG.instances.isolation : String(instancesIn.isolation)
  if (isolation !== 'uid' && isolation !== 'none') {
    throw new Error(`dsh-login: instances.isolation must be "uid" or "none" (got ${JSON.stringify(instancesIn.isolation)})`)
  }
  const osUserPrefix = instancesIn.osUserPrefix === undefined
    ? DEFAULT_CONFIG.instances.osUserPrefix
    : String(instancesIn.osUserPrefix)
  if (!/^[a-z_][a-z0-9_-]*$/.test(osUserPrefix) || osUserPrefix.length > 16) {
    throw new Error(`dsh-login: instances.osUserPrefix must be a lowercase Linux account prefix (<= 16 chars, got ${JSON.stringify(instancesIn.osUserPrefix)})`)
  }
  const maxOldSpaceMb = instancesIn.maxOldSpaceMb === undefined
    ? DEFAULT_CONFIG.instances.maxOldSpaceMb
    : Number(instancesIn.maxOldSpaceMb)
  if (!Number.isInteger(maxOldSpaceMb) || (maxOldSpaceMb !== 0 && (maxOldSpaceMb < 256 || maxOldSpaceMb > 65536))) {
    throw new Error(`dsh-login: instances.maxOldSpaceMb must be 0 (no cap) or an integer 256-65536 (got ${JSON.stringify(instancesIn.maxOldSpaceMb)})`)
  }
  const nprocLimit = instancesIn.nprocLimit === undefined
    ? DEFAULT_CONFIG.instances.nprocLimit
    : Number(instancesIn.nprocLimit)
  if (!Number.isInteger(nprocLimit) || (nprocLimit !== 0 && (nprocLimit < 16 || nprocLimit > 65535))) {
    throw new Error(`dsh-login: instances.nprocLimit must be 0 (no cap) or an integer 16-65535 (got ${JSON.stringify(instancesIn.nprocLimit)})`)
  }

  return {
    mode: 'hub',
    instance: false,
    db,
    allowCidrs: readCidrs(input),
    rejectProxyHeaders: input.rejectProxyHeaders === undefined ? true : Boolean(input.rejectProxyHeaders),
    sessionTtlSec,
    register,
    requireApproval,
    adminUsers,
    instances: {
      root: resolve(rootRaw),
      portBase,
      checkout: resolve(checkoutRaw),
      hubBase,
      isolation,
      osUserPrefix,
      maxOldSpaceMb,
      nprocLimit,
    },
  }
}

function normalizeHandoffTtl(value) {
  const ttl = value === undefined ? INSTANCE_DEFAULTS.handoffTtlSec : Number(value)
  if (!Number.isInteger(ttl) || ttl < 30 || ttl > 15 * 60) {
    throw new Error('dsh-login: handoffTtlSec must be an integer between 30 and 900')
  }
  return ttl
}

/** The instance's own listen port (hub writes it at provisioning; 0 = unknown). */
function normalizeInstancePort(value) {
  if (value === undefined) return 0
  const port = Number(value)
  // 0 is the "unknown" sentinel so a normalized config re-normalizes cleanly.
  if (port !== 0 && (!Number.isInteger(port) || port < 1024 || port > 65000)) {
    throw new Error('dsh-login: port must be an integer between 1024 and 65000 (or 0 = unknown)')
  }
  return port
}
