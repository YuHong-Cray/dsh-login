/**
 * dsh-login — `bin/passwd.mjs`（账号密码诊断/重置）的端到端验收。
 *
 * 用一个临时 SQLite 账号库跑真进程、真 stdin：确认「密码对 → ✅ / 密码错 → ❌」
 * 的判断与本插件登录用的是同一套校验，并且重置只动 password_hash。
 *
 * 不需要 MySQL、不需要网络：node --test test/passwd-cli.test.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { hashPassword } from '../lib/auth.js'
import { loadConfig, saveConfig } from '../lib/config.js'
import { createLoginDatabase } from '../lib/db-driver.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PASSWD = join(HERE, '..', 'bin', 'passwd.mjs')
const GOOD = 'correct-horse-battery'
const NEXT = 'brand-new-secret-1'

let home
let instanceHome

/** Run the CLI as a real child process with piped stdin. */
function runCli(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PASSWD, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out, err }))
    child.stdin.end(input)
  })
}

/** Read one account row straight from the store the CLI wrote to. */
async function accountRow(username) {
  const db = await createLoginDatabase(loadConfig(home).db)
  try {
    return await db.findByUsername(username)
  } finally {
    await db.close()
  }
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'dsh-login-passwd-'))
  saveConfig(home, {
    adminUsers: ['root'],
    register: 'open',
    db: { driver: 'sqlite', file: join(home, 'accounts.sqlite'), table: 'dsh_login' },
  })
  const db = await createLoginDatabase(loadConfig(home).db)
  await db.ensureTable()
  await db.register('alice', hashPassword(GOOD), 'approved')
  await db.close()

  instanceHome = mkdtempSync(join(tmpdir(), 'dsh-login-instance-'))
  saveConfig(instanceHome, { mode: 'instance', instance: true, port: 3100, hubBase: 'http://127.0.0.1:3080/' })
})

after(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(instanceHome, { recursive: true, force: true })
})

describe('passwd check', () => {
  it('reports a match for the password the account was created with', async () => {
    const res = await runCli(['check', 'alice', '--home', home], `${GOOD}\n`)
    assert.equal(res.code, 0, res.err)
    assert.match(res.out, /✅ 密码匹配/u)
    assert.match(res.out, /账号状态 approved/u)
  })

  it('reports a mismatch and the reset command for a wrong password', async () => {
    const res = await runCli(['check', 'alice', '--home', home], 'not-the-password\n')
    assert.equal(res.code, 1)
    assert.match(res.out, /❌ 密码不匹配/u)
    assert.match(res.out, /passwd\.mjs set alice/u)
  })

  it('reports a missing account without prompting for a password', async () => {
    const res = await runCli(['check', 'ghost', '--home', home], '')
    assert.equal(res.code, 1)
    assert.match(res.err, /账号 ghost 不存在/u)
  })
})

describe('passwd set', () => {
  it('replaces only the password hash, and the new password then verifies', async () => {
    const before = await accountRow('alice')
    const res = await runCli(['set', 'alice', '--yes', '--home', home], `${NEXT}\n${NEXT}\n`)
    assert.equal(res.code, 0, res.err)
    assert.match(res.out, /✅ 已重置 alice 的密码/u)

    const after = await accountRow('alice')
    assert.notEqual(after.password_hash, before.password_hash)
    assert.equal(after.status, before.status)
    assert.equal(after.model_self_service, before.model_self_service)

    assert.equal((await runCli(['check', 'alice', '--home', home], `${NEXT}\n`)).code, 0)
    assert.equal((await runCli(['check', 'alice', '--home', home], `${GOOD}\n`)).code, 1)
  })

  it('refuses a mismatched confirmation and leaves the hash alone', async () => {
    const before = await accountRow('alice')
    const res = await runCli(['set', 'alice', '--yes', '--home', home], 'aaaaaaaaaaaa\nbbbbbbbbbbbb\n')
    assert.equal(res.code, 2)
    assert.match(res.err, /两次输入不一致/u)
    assert.equal((await accountRow('alice')).password_hash, before.password_hash)
  })

  it('refuses a password outside the 8-128 rule', async () => {
    const before = await accountRow('alice')
    const res = await runCli(['set', 'alice', '--yes', '--home', home], 'short\nshort\n')
    assert.equal(res.code, 2)
    assert.match(res.err, /8-128/u)
    assert.equal((await accountRow('alice')).password_hash, before.password_hash)
  })
})

describe('passwd usage guards', () => {
  it('prints usage and fails when the subcommand is missing', async () => {
    const res = await runCli([])
    assert.equal(res.code, 2)
    assert.match(res.err, /用法/u)
  })

  it('refuses an unknown flag instead of guessing', async () => {
    const res = await runCli(['check', 'alice', '--nope'])
    assert.equal(res.code, 2)
    assert.match(res.err, /未知参数 --nope/u)
  })

  it('refuses an instance-mode home (no account table there)', async () => {
    const res = await runCli(['check', 'alice', '--home', instanceHome], `${GOOD}\n`)
    assert.equal(res.code, 2)
    assert.match(res.err, /instance 模式/u)
  })
})
