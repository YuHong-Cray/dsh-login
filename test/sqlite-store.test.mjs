/**
 * Acceptance coverage for the self-provisioned account store: driver selection,
 * the SQLite driver's full method surface (parity with lib/db.js), the
 * legacy-table migrations, and the `bin/verify.mjs` run a deployment finishes with.
 *
 * No MySQL and no network required — run it with:
 *   node --test test/sqlite-store.test.mjs
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { loadConfig, normalizeConfig, saveConfig } from '../lib/config.js'
import { createLoginDatabase, describeDb } from '../lib/db-driver.js'
import { SQLITE_DEFAULT_FILE, SqliteLoginDatabase } from '../lib/db-sqlite.js'
import { runVerify } from '../bin/verify.mjs'

/** A throwaway DSH_HOME for one case; removed when the case ends. */
function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-login-sqlite-'))
  return dir
}

describe('driver selection (db.driver / auto)', () => {
  it('falls back to SQLite when no database is configured', () => {
    const cfg = normalizeConfig({ adminUsers: ['root'] }, '/home/hub')
    assert.equal(cfg.db.driver, 'sqlite')
    assert.equal(cfg.db.file, join('/home/hub', SQLITE_DEFAULT_FILE))
    assert.equal(cfg.db.table, 'dsh_login')
  })

  it('keeps MySQL for a complete db block (existing deployments unchanged)', () => {
    const cfg = normalizeConfig({ db: { host: 'db.internal', user: 'u', database: 'd', password: 'p' } }, '/home/hub')
    assert.equal(cfg.db.driver, 'mysql')
    assert.equal(cfg.db.host, 'db.internal')
    assert.equal(cfg.db.port, 3306)
    assert.equal(cfg.db.table, 'dsh_login')
  })

  it('honours an explicit driver and a custom SQLite file', () => {
    const cfg = normalizeConfig({ db: { driver: 'sqlite', file: '/var/lib/dsh/accounts.sqlite', table: 'accounts' } }, '/home/hub')
    assert.equal(cfg.db.driver, 'sqlite')
    assert.equal(cfg.db.file, '/var/lib/dsh/accounts.sqlite')
    assert.equal(cfg.db.table, 'accounts')
  })

  it('rejects a half-configured MySQL block instead of silently switching stores', () => {
    assert.throws(
      () => normalizeConfig({ db: { host: 'db.internal', user: 'u' } }, '/home/hub'),
      /db\.host, db\.user and db\.database are required/,
    )
    assert.throws(
      () => normalizeConfig({ db: { driver: 'mysql' } }, '/home/hub'),
      /db\.driver=mysql/,
    )
  })

  it('rejects an unknown driver and a relative SQLite path', () => {
    assert.throws(() => normalizeConfig({ db: { driver: 'postgres' } }, '/h'), /db\.driver must be "mysql", "sqlite" or "auto"/)
    assert.throws(() => normalizeConfig({ db: { driver: 'sqlite', file: 'rel.sqlite' } }, '/h'), /db\.file must be an absolute path/)
  })

  it('round-trips through saveConfig/loadConfig', () => {
    const home = tempHome()
    after(() => rmSync(home, { recursive: true, force: true }))
    saveConfig(home, { adminUsers: ['root'], instances: { root: join(home, 'tenants'), checkout: '/stp-harness' } })
    const cfg = loadConfig(home)
    assert.equal(cfg.db.driver, 'sqlite')
    assert.equal(cfg.db.file, join(home, SQLITE_DEFAULT_FILE))
  })

  it('describeDb names the store for the startup log', () => {
    assert.equal(describeDb({ driver: 'sqlite', file: '/h/a.sqlite', table: 't' }), 'sqlite:/h/a.sqlite table=t')
    assert.equal(describeDb({ driver: 'mysql', host: 'h', port: 3306, database: 'd', table: 't' }), 'mysql:h:3306/d table=t')
  })
})

describe('SqliteLoginDatabase (parity with the MySQL driver)', () => {
  const home = tempHome()
  after(() => rmSync(home, { recursive: true, force: true }))
  const file = join(home, 'accounts.sqlite')
  const db = new SqliteLoginDatabase({ driver: 'sqlite', file, table: 'dsh_login' })
  // One shared store so the cases below also prove the driver's state carries
  // across calls; the table is created here so each case can run alone.
  before(async () => { await db.ensureTable() })

  it('creates the file and table on first use, private to the hub', async () => {
    assert.equal(await db.ensureTable(), 'dsh_login')
    assert.ok(existsSync(file))
    assert.equal(statSync(file).mode & 0o077, 0, 'account file must not be group/other readable')
    assert.equal(await db.health(), 'up')
  })

  it('registers, refuses duplicates, and reads the row back', async () => {
    assert.deepEqual(await db.register('alice', 'scrypt$1', 'pending'), { ok: true, status: 'pending' })
    assert.deepEqual(await db.register('alice', 'scrypt$2', 'pending'), { ok: false, code: 'exists' })
    const row = await db.findByUsername('alice')
    assert.equal(row.username, 'alice')
    assert.equal(row.password_hash, 'scrypt$1')
    assert.equal(row.status, 'pending')
    assert.equal(row.model_self_service, 0)
    assert.equal(await db.findByUsername('nobody'), undefined)
  })

  it('approves, revokes, and lists', async () => {
    assert.deepEqual(await db.setStatus('alice', 'approved'), { ok: true, changed: 1 })
    assert.deepEqual(await db.setStatus('alice', 'approved'), { ok: true, changed: 0 })
    assert.deepEqual(await db.setModelSelfService('alice', true), { ok: true, changed: 1 })
    await db.register('bob', 'scrypt$3', 'rejected')
    const users = await db.listUsers()
    assert.deepEqual(users.map((u) => u.username), ['alice', 'bob'])
    assert.equal(users[0].model_self_service, 1)
    assert.equal(users[1].status, 'rejected')
  })

  it('rejects an unknown status like the MySQL driver does', async () => {
    await assert.rejects(() => db.setStatus('alice', 'bogus'), /unknown account status/)
  })

  it('stamps last_login_at as ISO-8601 UTC that JS parses as the same instant', async () => {
    await db.touchLastLogin('alice')
    const [row] = await db.listUsers()
    assert.match(String(row.last_login_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    assert.ok(Math.abs(Date.parse(row.last_login_at) - Date.now()) < 5 * 60_000)
  })

  it('removes accounts and closes idempotently', async () => {
    assert.equal(await db.remove('bob'), 1)
    assert.equal(await db.remove('bob'), 0)
    db.close()
    db.close()
    assert.equal(await db.health(), 'up', 'the facade reopens the handle on demand')
    db.close()
  })

  it('adds the approval and self-service columns to a pre-existing table', async () => {
    const legacyFile = join(home, 'legacy.sqlite')
    const raw = new DatabaseSync(legacyFile)
    raw.exec(`CREATE TABLE "dsh_login" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      last_login_at TEXT
    )`)
    raw.exec(`INSERT INTO "dsh_login" (username, password_hash) VALUES ('veteran','scrypt$0')`)
    raw.close()

    const migrated = new SqliteLoginDatabase({ driver: 'sqlite', file: legacyFile, table: 'dsh_login' })
    await migrated.ensureTable()
    const row = await migrated.findByUsername('veteran')
    // Same defaults as the MySQL migration: old accounts stay usable, and old
    // accounts do NOT gain self-service rights on upgrade.
    assert.equal(row.status, 'approved')
    assert.equal(row.model_self_service, 0)
    migrated.close()
  })

  it('creates missing parent directories and keeps the file 0600', async () => {
    const nested = new SqliteLoginDatabase({ driver: 'sqlite', file: join(home, 'deep/nested/accounts.sqlite'), table: 't' })
    await nested.ensureTable()
    assert.equal(statSync(join(home, 'deep/nested/accounts.sqlite')).mode & 0o077, 0)
    nested.close()
  })

  it('re-tightens the account file to 0600 every time it opens it', async () => {
    chmodSync(file, 0o644)
    assert.equal(statSync(file).mode & 0o777, 0o644)
    const reopened = new SqliteLoginDatabase({ driver: 'sqlite', file, table: 'dsh_login' })
    await reopened.ensureTable()
    reopened.close()
    // The store holds password verifiers: a hub restart (or a verify run) must
    // undo any loosening, not just report it.
    assert.equal(statSync(file).mode & 0o777, 0o600)
  })

  it('rejects an unsafe table name', () => {
    assert.throws(() => new SqliteLoginDatabase({ driver: 'sqlite', file, table: 'a"; DROP' }), /db\.table must match/)
  })

  it('tags an unusable store as db-down so the HTTP layer answers 503', async () => {
    // A regular file where a directory must be: mkdirSync fails with ENOTDIR,
    // which is the same shape as an unwritable DSH_HOME.
    const blocker = join(home, 'not-a-directory')
    writeFileSync(blocker, 'x')
    const blocked = new SqliteLoginDatabase({ driver: 'sqlite', file: join(blocker, 'accounts.sqlite'), table: 't' })
    await assert.rejects(() => blocked.ensureTable(), (err) => err.dbDown === true)
    assert.equal(await blocked.health(), 'down')
  })

  it('createLoginDatabase resolves the driver from the config', async () => {
    const viaDriver = await createLoginDatabase({ driver: 'sqlite', file: join(home, 'sel.sqlite'), table: 't' })
    assert.equal(viaDriver.driver, 'sqlite')
    viaDriver.close()
  })
})

describe('bin/verify.mjs (post-deployment acceptance)', () => {
  it('passes offline on a bare deployment that provisioned its own store', async () => {
    const home = tempHome()
    after(() => rmSync(home, { recursive: true, force: true }))
    saveConfig(home, {
      adminUsers: ['root'],
      requireApproval: true,
      instances: { root: join(home, 'tenants'), checkout: '/stp-harness' },
    })
    mkdirSync(join(home, 'tenants'), { recursive: true })
    writeFileSync(join(home, '.credentials.yaml'), 'records:\n  client-connection/browser-session:\n    kind: grant\n')

    const result = await runVerify({ home, offline: true })
    assert.equal(result.exitCode, 0, result.output)
    assert.equal(result.counts.fail, 0, result.output)
    assert.ok(result.output.includes('建表/迁移'), result.output)
    assert.ok(existsSync(join(home, SQLITE_DEFAULT_FILE)), 'verify must have provisioned the store')
  })

  it('fails when the config file is missing', async () => {
    const home = tempHome()
    after(() => rmSync(home, { recursive: true, force: true }))
    const result = await runVerify({ home, offline: true })
    assert.equal(result.exitCode, 1)
    assert.ok(result.output.includes('配置文件存在'))
  })

  it('reads the config it was given, not the process environment', async () => {
    const home = tempHome()
    after(() => rmSync(home, { recursive: true, force: true }))
    writeFileSync(join(home, 'dsh-login.json'), '{ not json')
    const result = await runVerify({ home, offline: true })
    assert.equal(result.exitCode, 1)
    assert.ok(result.output.includes('配置可解析'), result.output)
  })
})
