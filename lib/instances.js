/**
 * dsh-login — per-user dsh instance lifecycle (hub mode only).
 *
 * Each regular user gets a dedicated `dsh web` process:
 *
 *   /root/dsh-users/<username>/          ← the user's DSH_HOME
 *     .credentials.yaml                  ← copy of the hub's (shared browser-session
 *                                          secret + LLM refs; lets the hub mint the
 *                                          handoff token for this instance)
 *     settings.yaml                      ← copy of the hub's (shared LLM provider)
 *     dsh-login.json                     ← instance-mode gate config (hub writes it)
 *     instance.json                      ← { port, pid, startedAt, provisionedAt }
 *     web.log                            ← the instance's stdout/stderr
 *     profiles/web/                      ← profile: dsh-base + dsh-web-app +
 *                                          dsh-lan-access + dsh-login (instance mode)
 *     sessions/ storages/ …              ← created by the instance at runtime
 *
 * The instance runs with cwd = the user's home, so the session controller's
 * default working directory (process.cwd()) is the user's own directory: new
 * sessions and tool files land there, never in a neighbour's tree.
 *
 * Ports are allocated from instances.portBase, persisted per user, and reused
 * across hub restarts (a stable URL per user keeps minted cookies valid).
 * Child processes are spawned detached: they survive a hub restart and are
 * re-adopted from instance.json; a dead instance is respawned on next use.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createConnection } from 'node:net'
import { networkInterfaces } from 'node:os'
import { existsSync, mkdirSync } from 'node:fs'
import { chmod, chown, copyFile, lstat, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

const INSTANCE_JSON = 'instance.json'
const READY_TIMEOUT_MS = 120_000
const READY_POLL_MS = 750
const INSTALL_TIMEOUT_MS = 180_000

/**
 * pnpm project config disabling hardlinks for instance profiles.
 *
 * pnpm's default import method hardlinks package files out of its content
 * store. A tenant home must be chowned to its uid, and chowning a hardlinked
 * inode re-owns the store copy for every other user of the store — so tenant
 * profiles install copies instead.
 */
const PACKAGE_IMPORT_NPMRC = 'package-import-method=copy\n'

/**
 * Profile `pnpm-workspace.yaml`.
 *
 * pnpm 10+ reads project settings from this file rather than `.npmrc`, so the
 * import method has to be declared here as well for the copy behaviour to hold
 * on current pnpm (12.x ignores the npmrc key); `.npmrc` remains for older
 * releases.
 */
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
packageImportMethod: copy
`

/** The first non-internal IPv4 of this host, or undefined. */
export function lanIp() {
  const ifaces = networkInterfaces()
  for (const entries of Object.values(ifaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return undefined
}

/** The hub's canonical base URL: explicit config, else LAN IP (or loopback). */
export function deriveHubBase(explicit, listenPort) {
  if (explicit) return explicit
  const host = lanIp() ?? '127.0.0.1'
  return `http://${host}:${String(listenPort)}/`
}

/** True when `username` is a safe path component under the instances root. */
export function isSafeUsername(username) {
  return typeof username === 'string'
    && username.length >= 2
    && username.length <= 32
    && /^[\u4e00-\u9fff\u3400-\u4dbfA-Za-z0-9._-]+$/.test(username)
    && username !== '.' && username !== '..'
    && !username.includes('..')
}

/** Default prefix for the per-tenant OS account. */
export const OS_USER_PREFIX = 'dsh-'

/** Default V8 heap cap (MiB) for one instance; 0 disables the flag. */
export const DEFAULT_MAX_OLD_SPACE_MB = 1536

/** Default per-tenant process cap enforced with prlimit; 0 disables it. */
export const DEFAULT_NPROC_LIMIT = 512

/** Candidate non-login shells for tenant accounts, in preference order. */
const NO_LOGIN_SHELLS = ['/usr/sbin/nologin', '/sbin/nologin', '/bin/false']

/** Candidate prlimit binaries, in preference order. */
const PRLIMIT_PATHS = ['/usr/bin/prlimit', '/usr/sbin/prlimit', '/bin/prlimit']

/**
 * Derive one tenant's OS account name from an application username.
 *
 * Application usernames may be non-ASCII (CJK is allowed by the login rules),
 * while Linux account names are limited to `[a-z_][a-z0-9_-]*` and 32 chars.
 * A short readable stem is kept when it survives sanitizing; a deterministic
 * digest suffix keeps the name unique and collision-resistant for names that
 * sanitize to the same stem (or to nothing at all).
 * @param username - the application account name.
 * @param prefix - account prefix; must itself be a valid Linux name prefix.
 * @returns a stable, ASCII, <= 32 character account name.
 */
export function osUserFor(username, prefix = OS_USER_PREFIX) {
  const safePrefix = /^[a-z_][a-z0-9_-]*$/.test(prefix) ? prefix : OS_USER_PREFIX
  const text = String(username)
  const stem = text.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 8)
  const digest = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 6)
  const name = stem.length > 0 ? `${safePrefix}${stem}-${digest}` : `${safePrefix}${digest}`
  return name.slice(0, 32)
}

/** Run a program without a shell and collect its output. */
function runProgram(file, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((done) => {
    let child
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      done({ code: -1, stdout: '', stderr: err?.message ?? String(err) })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    child.on('error', (err) => { clearTimeout(timer); done({ code: -1, stdout, stderr: `${stderr}${err.message}` }) })
    child.on('close', (code) => { clearTimeout(timer); done({ code: code ?? -1, stdout, stderr }) })
  })
}

/** Resolve one OS account to its numeric uid/gid, or undefined when absent. */
export async function resolveOsAccount(osUser) {
  const res = await runProgram('getent', ['passwd', osUser])
  if (res.code !== 0) return undefined
  const fields = res.stdout.trim().split('\n')[0].split(':')
  const uid = Number(fields[2])
  const gid = Number(fields[3])
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return undefined
  return { osUser, uid, gid }
}

/**
 * Resolve or create the tenant's OS account.
 *
 * The account is a `--system` non-login account with no home of its own: the
 * DSH_HOME is created and maintained by the hub, and only its ownership is
 * handed to this uid. Creation is idempotent and resolution after creation
 * fails loudly, so a partially provisioned account never becomes an instance
 * running with unexpected privileges.
 * @param osUser - derived account name.
 * @param homeDir - the tenant's DSH_HOME (recorded as the account's home field).
 * @returns the resolved numeric identity.
 */
export async function ensureOsAccount(osUser, homeDir) {
  const existing = await resolveOsAccount(osUser)
  if (existing !== undefined) return existing
  const shell = NO_LOGIN_SHELLS.find(candidate => existsSync(candidate)) ?? '/bin/false'
  const add = await runProgram('useradd', [
    '--system', '--no-create-home', '--shell', shell, '--home-dir', homeDir, osUser,
  ])
  if (add.code !== 0) {
    throw new Error(`dsh-login: useradd ${osUser} failed (${String(add.code)}): ${add.stderr.trim().slice(0, 300)}`)
  }
  const created = await resolveOsAccount(osUser)
  if (created === undefined) throw new Error(`dsh-login: ${osUser} was created but cannot be resolved`)
  return created
}

/**
 * Give every hardlinked regular file under `dir` a private inode.
 *
 * Belt and braces for the ownership handover: pnpm is configured to copy
 * packages, but a store link that slips through would be chowned with the rest
 * of the tree and would thereby re-own a file that the hub's own profile (or
 * the shared store) still references. Rewriting such files as private copies
 * keeps the chown confined to the tenant home.
 * @param dir - the tenant's DSH_HOME.
 * @returns the number of files rewritten.
 */
export async function breakSharedHardlinks(dir) {
  let broken = 0
  const walk = async (current) => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.isFile()) continue
      const info = await lstat(path).catch(() => undefined)
      if (info === undefined || info.nlink <= 1) continue
      const temp = `${path}.dsh-hardlink-break`
      try {
        await copyFile(path, temp)
        await chmod(temp, info.mode & 0o777)
        await rename(temp, path)
        broken += 1
      } catch {
        await rm(temp, { force: true }).catch(() => {})
      }
    }
  }
  await walk(dir)
  return broken
}

/**
 * Hand one tree to a tenant identity.
 *
 * `-h` keeps symlinks (notably the profile's pnpm links) from being
 * dereferenced, so a link into the checkout can never transfer ownership of
 * the checkout itself. Callers run {@link breakSharedHardlinks} first, so no
 * inode here is shared with the pnpm store or the hub's own profile.
 */
export async function chownTree(dir, uid, gid) {
  const res = await runProgram('chown', ['-R', '-h', '-P', `${String(uid)}:${String(gid)}`, dir], { timeoutMs: 300_000 })
  if (res.code !== 0) {
    throw new Error(`dsh-login: chown -R ${String(uid)}:${String(gid)} ${dir} failed: ${res.stderr.trim().slice(0, 300)}`)
  }
}

/**
 * Fail closed when tenant accounts cannot physically reach their own home.
 *
 * A tenant uid can only traverse directories that grant others execute. The
 * instances root itself is made traverse-only (0711: reachable, not listable),
 * but an ancestor the operator owns is never widened silently — moving the
 * root out of a 0700 home (e.g. `/root/dsh-users` -> `/srv/dsh-users`) is an
 * explicit deployment decision.
 * @param target - the instances root directory.
 * @returns the offending ancestor path when unreachable, else undefined.
 */
export async function findBlockingAncestor(target) {
  const absolute = resolve(target)
  const parts = absolute.split(sep).filter(Boolean)
  let current = ''
  for (const part of parts) {
    current += `${sep}${part}`
    const info = await stat(current).catch(() => undefined)
    if (info === undefined) break
    if ((info.mode & 0o001) !== 0) continue
    if (current === absolute) continue // the root itself is fixed by the caller
    return current
  }
  return undefined
}

/**
 * The hub's own CLI launch vector, mirrored for per-user instances.
 *
 * An instance MUST run in the hub's module plane. tsx's tsconfig `paths` map
 * projects every nested workspace import to the source file under `packages`,
 * while the profile's package resolution loads loader *entries* from the
 * installation's built `lib/*.js`. Booting `src/bin.ts` under tsx therefore
 * loads `@deepseek-ai/dsh-tools` twice — the mounted ToolRuntime comes from
 * `lib/index.js`, the agent loop reads the module-local
 * `TOOL_RUNTIME_SCHEDULER` symbol from `src/index.ts` — and every tool call
 * fails the turn with `Cannot read properties of undefined (reading
 * 'prepare')`, with stop code `UNKNOWN`.
 *
 * Mirroring `process.argv[1]` (plus the tsx loader and pinned paths map when
 * the hub itself runs from source) keeps an instance on exactly the hub's
 * vector: an artifact-plane hub spawns artifact-plane instances.
 * @param checkout - the DSH checkout that owns `apps/cli`.
 * @returns the entry file, the loader flags, and extra child environment.
 */
export function instanceLaunchVector(checkout) {
  const hubEntry = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
  const cliEntry = (suffix) => hubEntry !== undefined
    && hubEntry.endsWith(`${sep}${suffix}`)
    && hubEntry.includes(`${sep}apps${sep}cli${sep}`)
  if (cliEntry('bin.ts')) {
    // The hub runs the source plane, so the instance must too: tsx's loader
    // plus the checkout's tsconfig paths (the instance's cwd is the user's home,
    // which has no tsconfig of its own to walk up to).
    return {
      entry: hubEntry,
      execArgv: ['--import', join(checkout, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')],
      env: { TSX_TSCONFIG_PATH: join(checkout, 'tsconfig.json') },
    }
  }
  return {
    entry: cliEntry('bin.js') ? hubEntry : join(checkout, 'apps', 'cli', 'lib', 'bin.js'),
    execArgv: [],
    env: {},
  }
}

/**
 * Render the minimal `.credentials.yaml` for a user instance: ONLY the shared
 * browser-session signing secret.
 *
 * That secret is the one credential that can never be per-user — the hub mints
 * the handoff with it and the instance verifies that handoff and signs its own
 * cookie audience with the same value. Everything else (provider API keys in
 * particular) is deliberately absent: every user owns their own credentials
 * and adds them in their own GUI.
 * @param secret - the hub's 32-byte browser-session secret.
 * @returns the YAML text of a minimal credentials document.
 */
export function renderInstanceCredentials(secret) {
  const b64 = Buffer.from(secret).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
  return [
    'version: 1',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    `      secret: ${b64}`,
    'refs: {}',
    '',
  ].join('\n')
}

/**
 * Settings every brand-new instance starts from.
 *
 * A user instance owns no provider route and no API key of its own: those are
 * granted per user by the administrator (user-management → 模型) or added by
 * the user in their own instance. Nothing is inherited from the hub.
 *
 * The one entry hides DSH's BUILT-IN `deepseek-official` catalog (shipped by
 * `@deepseek-ai/dsh-base`; it is advertised regardless of any administrator
 * configuration and is unusable without a `DEEPSEEK_API_KEY`). Hiding it keeps
 * the picker honest: a user only sees models this deployment actually granted.
 * JSON is valid YAML, so this is a valid settings document.
 */
export const INSTANCE_SETTINGS_TEMPLATE = `${JSON.stringify({ 'llm-deepseek': { models: [] } }, null, 2)}\n`

/**
 * Owns provisioning, spawning, readiness, and liveness of the per-user
 * instances. All methods are safe to call concurrently per user (in-flight
 * deduplication) and across hub restarts (state lives in instance.json).
 */
export class InstanceManager {
  /**
   * @param opts.root - instances root directory (absolute).
   * @param opts.portBase - first assignable port.
   * @param opts.checkout - the DSH source checkout used to spawn instances.
   * @param opts.hubHome - the hub's DSH_HOME (settings/credentials copy source).
   * @param opts.hubPort - the hub's own listen port (never assigned to users).
   * @param opts.hubBase - the hub's canonical base URL for instance configs.
   * @param opts.allowCidrs - CIDR list copied into instance configs.
   * @param opts.rejectProxyHeaders - copied into instance configs.
   * @param opts.logger - { warn, error } sink.
   * @param opts.isolation - 'uid' runs every instance as its own non-root OS
   *   account with the DSH_HOME handed to that uid; 'none' keeps the legacy
   *   root-mode instances (single-tenant / development only).
   * @param opts.osUserPrefix - account name prefix for derived tenant accounts.
   * @param opts.maxOldSpaceMb - V8 heap cap per instance; 0 disables the flag.
   * @param opts.nprocLimit - per-tenant process cap via prlimit; 0 disables it.
   * @param opts.signingSecret - async () => the hub's browser-session secret
   *   (Buffer). Written into each provisioned instance's credentials file;
   *   the one value that must be shared with the hub.
   */
  constructor(opts) {
    this.root = resolve(opts.root)
    this.portBase = opts.portBase
    this.checkout = resolve(opts.checkout)
    this.hubHome = resolve(opts.hubHome)
    this.hubPort = opts.hubPort
    this.hubBase = opts.hubBase
    this.allowCidrs = opts.allowCidrs
    this.rejectProxyHeaders = opts.rejectProxyHeaders
    this.logger = opts.logger
    this.signingSecret = opts.signingSecret
    this.isolation = opts.isolation ?? 'uid'
    this.osUserPrefix = opts.osUserPrefix ?? OS_USER_PREFIX
    this.maxOldSpaceMb = opts.maxOldSpaceMb ?? DEFAULT_MAX_OLD_SPACE_MB
    this.nprocLimit = opts.nprocLimit ?? DEFAULT_NPROC_LIMIT
    this.inflight = new Map()
    this.reservedPorts = new Set([this.hubPort])
  }

  /** Whether per-tenant OS accounts are in use. */
  isolationEnabled() {
    return this.isolation === 'uid'
  }

  /**
   * Make the instances root reachable by tenant accounts.
   *
   * The root becomes traverse-only (0711: tenants can reach their own home but
   * cannot list their neighbours). An ancestor owned by someone else is never
   * widened silently: a 0700 `/root` would make every tenant home unreachable,
   * and that must be fixed by moving the root (e.g. `/root/dsh-users` ->
   * `/srv/dsh-users`), not by opening `/root`.
   */
  async assertTenantReachable() {
    const blocking = await findBlockingAncestor(this.root)
    if (blocking !== undefined) {
      throw new Error(
        `dsh-login: instances.root ${this.root} is unreachable by tenant accounts: ${blocking} lacks o+x; `
        + 'move the instances root outside that directory (e.g. /srv/dsh-users) instead of widening it',
      )
    }
    await mkdirSync(this.root, { recursive: true })
    const info = await stat(this.root).catch(() => undefined)
    if (info !== undefined && (info.mode & 0o777) !== 0o711) {
      // Traverse-only: a tenant can reach its own home, never enumerate the
      // others (the hub keeps full access as the owner).
      await chmod(this.root, 0o711)
    }
  }

  /**
   * Resolve/create the tenant's OS account and hand the home over to it.
   *
   * Runs before every spawn. A home still owned by the hub (a legacy root-mode
   * instance, or a restore from backup) is migrated: the recorded process is
   * stopped, the profile packages are reinstalled without hardlinks, and the
   * tree is chowned. Reinstalling first matters because pnpm's default import
   * method hardlinks store files into `node_modules`; chowning a shared inode
   * would re-own store content for the whole host.
   * @param username - the application account name.
   * @param dir - the tenant's DSH_HOME.
   * @returns the numeric identity to drop to, or undefined when isolation is off.
   */
  async prepareTenantHome(username, dir) {
    if (!this.isolationEnabled()) return undefined
    this.assertIsolationSupported()
    const osUser = osUserFor(username, this.osUserPrefix)
    const account = await ensureOsAccount(osUser, dir)
    await this.assertTenantReachable()
    const info = await stat(dir).catch(() => undefined)
    if (info !== undefined && info.uid !== account.uid) {
      this.logger.warn?.(`dsh-login: migrating ${username}'s home to ${osUser} (uid ${String(account.uid)})`)
      await this.stopRecordedInstance(username)
      await this.rewriteProfilePackages(dir)
      const broken = await breakSharedHardlinks(dir)
      if (broken > 0) this.logger.warn?.(`dsh-login: broke ${String(broken)} store hardlink(s) in ${username}'s home before chown`)
      await chownTree(dir, account.uid, account.gid)
    }
    if (info !== undefined) await chmod(dir, 0o700)
    return account
  }

  /**
   * Stop the instance recorded in `instance.json`, and prove the port is free.
   *
   * The pid is verified against `/proc/<pid>/cmdline` before signalling: a
   * stale record whose pid was recycled must never kill an unrelated process,
   * and a home cannot be handed to a tenant while a root-mode instance is
   * still serving it. A port that stays busy fails loudly instead.
   * @param username - the application account name.
   */
  async stopRecordedInstance(username) {
    const rec = await this.readInstance(username)
    if (rec !== undefined && Number.isInteger(rec.pid)) {
      const cmdline = await readFile(`/proc/${String(rec.pid)}/cmdline`, 'utf8').catch(() => undefined)
      const looksLikeInstance = cmdline !== undefined
        && cmdline.includes('apps/cli')
        && cmdline.includes('--port')
        && cmdline.includes(String(rec.port))
      if (looksLikeInstance) {
        try { process.kill(rec.pid, 'SIGTERM') } catch { /* already gone */ }
      }
    }
    const deadline = Date.now() + 20_000
    while (await this.portBusy(rec?.port ?? 0)) {
      if (Date.now() > deadline) {
        throw new Error(`dsh-login: port ${String(rec?.port)} is still held; cannot migrate ${username} to an isolated account`)
      }
      await new Promise(r => setTimeout(r, 250))
    }
  }

  /**
   * Reinstall the profile packages so nothing is a hardlink into the pnpm
   * store. `package-import-method=copy` in the profile's `.npmrc` keeps it
   * that way for future installs.
   *
   * The lockfile is dropped as well: pnpm records `file:` dependencies
   * relative to the project directory, so a home that moved to a different
   * depth (the `/root/dsh-users` -> `/srv/dsh-users` migration) would resolve
   * the plugin source to a path that no longer exists. `package.json` carries
   * the absolute path, so a clean resolve is both correct and cheap.
   * @param dir - the tenant's DSH_HOME.
   */
  async rewriteProfilePackages(dir) {
    const profileDir = join(dir, 'profiles', 'web')
    if (!existsSync(join(profileDir, 'package.json'))) return
    await writeFile(join(profileDir, '.npmrc'), PACKAGE_IMPORT_NPMRC)
    await writeFile(join(profileDir, 'pnpm-workspace.yaml'), PROFILE_PNPM_WORKSPACE)
    await rm(join(profileDir, 'node_modules'), { recursive: true, force: true })
    await rm(join(profileDir, 'pnpm-lock.yaml'), { force: true })
    await this.runPnpmInstall(profileDir)
  }

  userDir(username) {
    if (!isSafeUsername(username)) {
      throw new Error(`dsh-login: refusing to provision unsafe username ${JSON.stringify(username)}`)
    }
    const dir = resolve(this.root, username)
    if (dir !== this.root && !dir.startsWith(`${this.root}/`)) {
      throw new Error(`dsh-login: username escapes the instances root: ${JSON.stringify(username)}`)
    }
    return dir
  }

  /**
   * (Re)bind the hub's current listen port and canonical base URL. Called on
   * every manager access: at apply() time the hub's server may not be
   * listening yet, so the values are refreshed lazily.
   */
  setHub(port, hubBase) {
    if (Number.isInteger(port) && port > 0 && port !== this.hubPort) {
      this.reservedPorts.delete(this.hubPort)
      this.hubPort = port
      this.reservedPorts.add(port)
    }
    if (typeof hubBase === 'string' && hubBase !== '') this.hubBase = hubBase
  }

  instanceFile(username) {
    return join(this.userDir(username), INSTANCE_JSON)
  }

  async readInstance(username) {
    try {
      const raw = await readFile(this.instanceFile(username), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed.port === 'number' && Number.isInteger(parsed.port)) return parsed
      return undefined
    } catch {
      return undefined
    }
  }

  /** All provisioned users with their records, sorted by username. */
  async listUsers() {
    let entries
    try {
      entries = await readdir(this.root, { withFileTypes: true })
    } catch {
      return []
    }
    const records = []
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const rec = await this.readInstance(entry.name)
      if (rec === undefined) continue
      records.push({ username: entry.name, ...rec })
    }
    // Probe in parallel: the users page would otherwise wait 3s per user.
    const probed = await Promise.all(
      records.map(async (rec) => {
        const health = await this.probeHealth(rec.port)
        let ours = true
        if (health.ok && health.identity !== undefined) {
          try {
            ours = health.identity === this.identityOf(this.userDir(rec.username))
          } catch {
            ours = true
          }
        }
        return { ...rec, running: health.ok && ours }
      }),
    )
    return probed.sort((a, b) => a.username.localeCompare(b.username))
  }

  /**
   * Remove a user's instance: kill the running process (if any), delete the
   * whole DSH_HOME directory, and drop in-flight state. The account row in
   * the database is owned by the caller (hub mode).
   */
  async remove(username) {
    const dir = this.userDir(username)
    const rec = await this.readInstance(username)
    if (rec !== undefined && Number.isInteger(rec.pid)) {
      try { process.kill(rec.pid, 'SIGTERM') } catch { /* already gone */ }
    }
    await rm(dir, { recursive: true, force: true })
    if (this.isolationEnabled()) {
      // Best effort: the account is per application user and harmless when it
      // outlives one home, but leaving it behind would squat the name forever.
      const osUser = osUserFor(username, this.osUserPrefix)
      if (await resolveOsAccount(osUser) !== undefined) {
        const res = await runProgram('userdel', [osUser])
        if (res.code !== 0) {
          this.logger.warn?.(`dsh-login: userdel ${osUser} failed: ${res.stderr.trim().slice(0, 200)}`)
        }
      }
    }
    this.inflight.delete(username)
  }

  /**
   * Assign a free port >= portBase, avoiding reserved, assigned, AND actually
   * listening ports.
   *
   * The last check matters: a stale instance whose home directory was replaced
   * (e.g. the operator deleted `/root/dsh-users/<u>` while it kept running)
   * still holds its old port. Reusing that port makes the new instance die with
   * `EADDRINUSE` and leaves the stale process answering for a directory that no
   * longer exists — which surfaces as `ENOENT .../sessions/...` in the GUI. So
   * a busy port is skipped and the user simply moves to the next one.
   */
  async allocatePort() {
    const taken = new Set(this.reservedPorts)
    for (const rec of await this.listUsers()) taken.add(rec.port)
    for (let port = this.portBase; port <= 65535; port += 1) {
      if (taken.has(port)) continue
      if (await this.portBusy(port)) continue
      return port
    }
    throw new Error('dsh-login: no free instance ports left')
  }

  /** Stable identity of the home an instance on a port must be serving. */
  identityOf(dir) {
    return createHash('sha256').update(resolve(dir), 'utf8').digest('hex').slice(0, 16)
  }

  /** Whether anything is listening on that loopback port. */
  portBusy(port) {
    return new Promise((done) => {
      const socket = createConnection({ host: '127.0.0.1', port })
      const settle = (busy) => { socket.destroy(); done(busy) }
      socket.setTimeout(1000)
      socket.once('connect', () => settle(true))
      socket.once('timeout', () => settle(true))
      socket.once('error', () => settle(false))
    })
  }

  /**
   * Ask the instance on `port` what it is serving.
   * @param port - candidate port.
   * @returns `{ok, identity}`; `identity` is absent on instances running an
   *   older plugin build (in which case callers keep the previous behaviour).
   */
  async probeHealth(port) {
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/dsh-login/health`, {
        signal: AbortSignal.timeout(3000),
      })
      if (!res.ok) return { ok: false }
      const body = await res.json()
      if (body === null || typeof body !== 'object' || body.ok !== true) return { ok: false }
      return { ok: true, identity: typeof body.identity === 'string' ? body.identity : undefined }
    } catch {
      return { ok: false }
    }
  }

  /**
   * Ensure the user's instance is running; returns its port. Provisions the
   * home + profile on first use, respawns a dead instance, and waits for
   * readiness. Concurrent calls for the same user share one attempt.
   * @param username - the account name.
   * @returns the listening port.
   */
  ensure(username) {
    const existing = this.inflight.get(username)
    if (existing !== undefined) return existing
    const attempt = this.doEnsure(username)
    this.inflight.set(username, attempt)
    attempt.finally(() => { this.inflight.delete(username) }).catch(() => {})
    return attempt
  }

  async doEnsure(username) {
    const dir = this.userDir(username)
    const identity = this.identityOf(dir)
    let rec = await this.readInstance(username)
    if (rec !== undefined) {
      const health = await this.probeHealth(rec.port)
      if (health.ok && (health.identity === undefined || health.identity === identity)) {
        return rec.port
      }
      // The recorded port is held by something that is NOT serving this home:
      // a stale instance whose directory was replaced, or an unrelated
      // listener. Spawning there would die with EADDRINUSE, so move this user
      // to a free port and leave the stale process alone.
      if (health.ok || await this.portBusy(rec.port)) {
        const port = await this.allocatePort()
        this.logger.warn?.(`dsh-login: port ${String(rec.port)} is not serving ${username}'s current home; moving to ${String(port)}`)
        rec = { ...rec, port }
      }
    }
    if (rec === undefined) {
      const port = await this.allocatePort()
      await this.provision(username, dir, port)
      rec = { port, pid: null, startedAt: 0, provisionedAt: Date.now() }
      await writeFile(this.instanceFile(username), `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 })
      this.logger.warn?.(`dsh-login: provisioned user instance ${username} on port ${String(port)}`)
    } else {
      this.logger.warn?.(`dsh-login: instance ${username} (port ${String(rec.port)}) is not answering; respawning`)
    }
    const account = await this.prepareTenantHome(username, dir)
    const pid = await this.spawn(username, dir, rec.port, account)
    rec = {
      ...rec,
      pid,
      startedAt: Date.now(),
      ...account === undefined ? {} : { osUser: account.osUser },
    }
    await writeFile(this.instanceFile(username), `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 })
    await this.waitReady(rec.port)
    return rec.port
  }

  /**
   * Create the user's DSH_HOME, profile, configs, and install the profile
   * dependencies (store-backed pnpm install; no network for cached packages).
   *
   * Per-user configuration is INDEPENDENT by design: the instance starts with
   * EMPTY settings (the user adds their own providers/models/keys) and its
   * credentials file carries only the shared browser-session signing secret —
   * the one value that must match the hub for the handoff to verify. No
   * administrator API key or model choice is inherited.
   */
  async provision(username, dir, port) {
    const profileDir = join(dir, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })

    const credentialsPath = join(dir, '.credentials.yaml')
    const signingSecret = this.signingSecret === undefined ? undefined : await this.signingSecret()
    if (signingSecret !== undefined) {
      await writeFile(credentialsPath, renderInstanceCredentials(signingSecret), { mode: 0o600 })
      await chmod(credentialsPath, 0o600)
    } else {
      // No signing seam: fall back to the hub's file (older behaviour) so the
      // handoff still verifies, and say so — a user's own keys then start out
      // inherited, which is not what this deployment wants.
      this.logger.warn?.('dsh-login: no signing secret available; copying the hub credentials file')
      try {
        await copyFile(join(this.hubHome, '.credentials.yaml'), credentialsPath)
        await chmod(credentialsPath, 0o600)
      } catch (err) {
        if (err?.code !== 'ENOENT') this.logger.warn?.(`dsh-login: could not copy .credentials.yaml: ${err?.message ?? String(err)}`)
      }
    }
    await writeFile(join(dir, 'settings.yaml'), INSTANCE_SETTINGS_TEMPLATE, { mode: 0o644 })

    const vendorSrc = join(this.hubHome, 'profiles', 'web', 'vendor', 'dsh-login')
    await lstat(vendorSrc) // fail fast: the hub's plugin source must exist

    const manifest = {
      name: 'dsh-profile-web',
      private: true,
      dependencies: {
        'dsh-lan-access': '^0.1.3',
        // Absolute file: path: pnpm copies the plugin into the instance's
        // node_modules at install time (the hoisted linker does not follow
        // workspace symlinks outside the profile directory).
        'dsh-login': `file:${vendorSrc}`,
      },
      dsh: {
        profile: {
          bundles: [
            '@deepseek-ai/dsh-base',
            '@deepseek-ai/dsh-web-app',
            'dsh-lan-access',
            'dsh-login',
          ],
          patchReload: 'live',
        },
      },
    }
    await writeFile(join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await writeFile(join(profileDir, 'pnpm-workspace.yaml'), PROFILE_PNPM_WORKSPACE)
    // Copies, never hardlinks: the home is chowned to the tenant uid, and a
    // chown of a hardlinked store inode would re-own store content host-wide
    // (including the hub's own profile, which shares those inodes).
    await writeFile(join(profileDir, '.npmrc'), PACKAGE_IMPORT_NPMRC)
    // The GUI terminal is a shell in the instance, not in the hub: with
    // per-tenant uids it would be the tenant's own unprivileged shell, but it
    // stays disabled by default so a tenant cannot use it to widen their own
    // environment. Enable per profile only when that is wanted.
    await writeFile(join(profileDir, 'cordis.patch.yml'),
      `# Regular-user instances: no GUI terminals by default.
- id: terminal-controller
  disabled: true
- id: ui-sidebar-terminal
  disabled: true
`)

    const instanceCfg = {
      instance: true,
      port,
      hubBase: this.hubBase,
      allowCidrs: [...this.allowCidrs],
      rejectProxyHeaders: this.rejectProxyHeaders,
    }
    // Instance mode config, written through the shared normalizer (0600).
    const { saveConfig } = await import('./config.js')
    saveConfig(dir, instanceCfg)

    await this.runPnpmInstall(profileDir)

    if (this.isolationEnabled()) {
      // Hand the freshly provisioned tree to the tenant before the first spawn,
      // so the instance never starts with the hub's identity.
      this.assertIsolationSupported()
      const account = await ensureOsAccount(osUserFor(username, this.osUserPrefix), dir)
      await this.assertTenantReachable()
      const broken = await breakSharedHardlinks(dir)
      if (broken > 0) this.logger.warn?.(`dsh-login: broke ${String(broken)} store hardlink(s) in ${username}'s home before chown`)
      await chownTree(dir, account.uid, account.gid)
      await chmod(dir, 0o700)
    }
  }

  /** Fail closed when this hub cannot actually isolate tenant uids. */
  assertIsolationSupported() {
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      throw new Error('dsh-login: instances.isolation "uid" requires the hub to run as root')
    }
  }

  async runPnpmInstall(profileDir) {
    const { spawn: spawnChild } = await import('node:child_process')
    await new Promise((resolveP, rejectP) => {
      const child = spawnChild('pnpm', ['install', '--reporter=silent'], {
        cwd: profileDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stdout.on('data', () => {})
      child.stderr.on('data', (chunk) => { stderr += String(chunk) })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        rejectP(new Error(`dsh-login: pnpm install timed out after ${String(INSTALL_TIMEOUT_MS / 1000)}s: ${stderr.slice(-500)}`))
      }, INSTALL_TIMEOUT_MS)
      child.on('error', (err) => {
        clearTimeout(timer)
        rejectP(new Error(`dsh-login: pnpm install failed to start: ${err.message}`))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolveP()
        else rejectP(new Error(`dsh-login: pnpm install exited ${String(code)}: ${stderr.slice(-500)}`))
      })
    })
  }

  /** Spawn the detached instance process; returns its pid. */
  async spawn(username, dir, port, account) {
    const log = await open(join(dir, 'web.log'), 'a')
    const vector = instanceLaunchVector(this.checkout)
    const nodeArgs = [
      ...this.maxOldSpaceMb > 0 ? [`--max-old-space-size=${String(this.maxOldSpaceMb)}`] : [],
      // Node options must precede the entry point (tsx's --import included).
      ...vector.execArgv,
      vector.entry,
      'web', '--no-open', '--port', String(port),
    ]
    // A per-tenant process cap turns a runaway agent or a fork bomb into one
    // user's failure instead of a host incident. prlimit lowers RLIMIT_NPROC
    // for the tenant uid; the flag is skipped when the tool is unavailable.
    const prlimit = this.nprocLimit > 0 ? PRLIMIT_PATHS.find(candidate => existsSync(candidate)) : undefined
    const child = spawn(
      prlimit ?? process.execPath,
      prlimit === undefined
        ? nodeArgs
        : [`--nproc=${String(this.nprocLimit)}`, '--', process.execPath, ...nodeArgs],
      {
        cwd: dir, // defaultCwd (process.cwd()) becomes the user's own directory
        env: {
          ...process.env,
          ...vector.env,
          DSH_HOME: dir,
          ...account === undefined ? {} : {
            HOME: dir,
            USER: account.osUser,
            LOGNAME: account.osUser,
          },
        },
        ...account === undefined ? {} : { uid: account.uid, gid: account.gid },
        stdio: ['ignore', log.fd, log.fd],
        detached: true,
      })
    child.unref()
    await log.close()
    if (account !== undefined) {
      // The inherited fd keeps writes working; owning the file lets the tenant
      // read its own instance log.
      await chown(join(dir, 'web.log'), account.uid, account.gid).catch(() => {})
    }
    const pid = child.pid
    if (pid === undefined) throw new Error('dsh-login: instance spawn returned no pid')
    child.on('error', (err) => {
      this.logger.error?.(`dsh-login: instance ${username} process error: ${err.message}`)
    })
    return pid
  }

  /** Wait until the instance answers /dsh-login/health on loopback. */
  async waitReady(port) {
    const deadline = Date.now() + READY_TIMEOUT_MS
    let lastError = ''
    for (;;) {
      if ((await this.probeHealth(port)).ok) return
      if (Date.now() > deadline) {
        throw new Error(`dsh-login: instance on port ${String(port)} did not become ready within ${String(READY_TIMEOUT_MS / 1000)}s (${lastError})`)
      }
      lastError = 'no response yet'
      await new Promise((r) => { setTimeout(r, READY_POLL_MS) })
    }
  }
}
