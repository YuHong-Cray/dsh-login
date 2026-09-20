/**
 * dsh-login — per-tenant OS isolation.
 *
 * Two layers are checked:
 *
 *  1. Pure derivation and the layout guard, always.
 *  2. A real drop-privilege check whenever the suite runs as root: a tenant
 *     account is created, a home is handed to it, and a child process spawned
 *     as that uid must read its own home while being refused the hub's 0700
 *     `/root` tree. This is the property the whole feature exists for, so it is
 *     asserted against the kernel rather than mocked.
 *
 * Run:  node --test test/os-isolation.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { chmod, link, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import {
  InstanceManager,
  breakSharedHardlinks,
  ensureOsAccount,
  findBlockingAncestor,
  osUserFor,
  resolveOsAccount,
} from '../lib/instances.js'

const ROOT = typeof process.getuid === 'function' && process.getuid() === 0
const HAS_TOOLS = ['/usr/sbin/useradd', '/usr/bin/getent', '/usr/bin/chown']
  .every(candidate => existsSync(candidate))
const CAN_ISOLATE = ROOT && HAS_TOOLS

const scratch = []
const accounts = []

after(async () => {
  for (const account of accounts) spawnSync('userdel', [account])
  for (const dir of scratch) await rm(dir, { recursive: true, force: true })
})

async function scratchDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  await chmod(dir, 0o755)
  scratch.push(dir)
  return dir
}

describe('tenant account derivation', () => {
  it('produces a stable, valid, unique Linux account name', () => {
    assert.equal(osUserFor('tty'), osUserFor('tty'))
    assert.match(osUserFor('tty'), /^dsh-[a-z0-9-]+$/)
    assert.ok(osUserFor('tty').length <= 32)
    // Non-ASCII names still yield an ASCII account.
    assert.match(osUserFor('张三'), /^dsh-[a-z0-9-]+$/)
    // Names that sanitize to the same stem stay distinct.
    assert.notEqual(osUserFor('a.b'), osUserFor('a-b'))
    // Long names are bounded.
    assert.ok(osUserFor('VeryLongUserName1234567890').length <= 32)
    assert.equal(osUserFor('tty', 'dshx-'), 'dshx-tty-544996')
    // An invalid prefix falls back to the default rather than producing a
    // name `useradd` would reject.
    assert.match(osUserFor('tty', 'BAD PREFIX'), /^dsh-/)
  })
})

describe('hardlink safety', () => {
  it('rewrites a store-shared inode in a tenant home as a private copy', async () => {
    const home = await scratchDir('dsh-login-links-')
    const store = await scratchDir('dsh-login-store-')
    const storeFile = join(store, 'blob')
    await writeFile(storeFile, 'shared bytes\n')
    const homeFile = join(home, 'pkg.js')
    await link(storeFile, homeFile) // what pnpm's default import method does
    assert.equal((await stat(homeFile)).nlink, 2)

    const broken = await breakSharedHardlinks(home)
    assert.equal(broken, 1)
    assert.equal((await stat(homeFile)).nlink, 1, 'home file owns a private inode')
    assert.equal((await stat(storeFile)).nlink, 1, 'store inode is no longer shared')
    assert.equal(await readFile(homeFile, 'utf8'), 'shared bytes\n')
  })
})

describe('layout guard', () => {
  it('reports the ancestor that tenants cannot traverse', async () => {
    const dir = await scratchDir('dsh-login-iso-')
    await chmod(dir, 0o700)
    const blocked = await findBlockingAncestor(join(dir, 'users'))
    assert.equal(blocked, dir)
    await chmod(dir, 0o755)
    assert.equal(await findBlockingAncestor(join(dir, 'users')), undefined)
  })
})

describe('per-tenant uid isolation', { skip: CAN_ISOLATE ? false : 'requires root and useradd/getent/chown' }, () => {
  it('hands a home to a non-root account that cannot reach the hub tree', async () => {
    const root = await scratchDir('dsh-login-root-')
    const home = join(root, 'tenant')
    mkdirSync(home)
    await writeFile(join(home, 'mine.txt'), 'tenant data\n')

    // A root-only secret standing in for /root/.dsh: 0600 inside a 0700 dir.
    const hubOnly = await mkdtemp(join(tmpdir(), 'dsh-login-hubonly-'))
    scratch.push(hubOnly)
    await chmod(hubOnly, 0o700)
    const secretPath = join(hubOnly, 'secret.txt')
    writeFileSync(secretPath, 'hub secret\n', { mode: 0o600 })

    const manager = new InstanceManager({
      root,
      portBase: 45000,
      checkout: '/stp-harness',
      hubHome: hubOnly,
      hubPort: 1,
      hubBase: '',
      allowCidrs: [],
      rejectProxyHeaders: true,
      isolation: 'uid',
      logger: { warn() {}, error() {} },
      signingSecret: async () => Buffer.alloc(32),
    })

    const account = await manager.prepareTenantHome('tenant', home)
    accounts.push(account.osUser)

    const info = await stat(home)
    assert.equal(info.uid, account.uid, 'home is owned by the tenant uid')
    assert.equal(info.gid, account.gid, 'home is owned by the tenant gid')
    assert.equal(info.mode & 0o777, 0o700, 'home is private to the tenant')
    assert.equal((await stat(root)).mode & 0o001, 0o001, 'instances root stays traversable')

    const probe = (script) => spawnSync(process.execPath, ['-e', script], {
      uid: account.uid,
      gid: account.gid,
      encoding: 'utf8',
    })

    const own = probe(`process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(join(home, 'mine.txt'))}, 'utf8'))`)
    assert.equal(own.status, 0, `tenant reads its own home: ${own.stderr}`)
    assert.equal(own.stdout, 'tenant data\n')

    const other = probe(`require('node:fs').readFileSync(${JSON.stringify(secretPath)}, 'utf8')`)
    assert.notEqual(other.status, 0, 'tenant must not read a root-only file')
    assert.match(other.stderr, /EACCES|EPERM/, 'refusal is a permission error, not a missing file')

    const checkout = probe(`require('node:fs').writeFileSync('/stp-harness/.dsh-iso-probe', 'x')`)
    assert.notEqual(checkout.status, 0, 'tenant must not write into the checkout')
  })

  it('creates and resolves a tenant account idempotently', async () => {
    const account = await ensureOsAccount(osUserFor('isolation probe'), '/tmp')
    accounts.push(account.osUser)
    assert.deepEqual(await resolveOsAccount(account.osUser), account)
    assert.notEqual(account.uid, 0)
  })
})
