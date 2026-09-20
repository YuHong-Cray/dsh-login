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
import { mkdirSync } from 'node:fs'
import { chmod, copyFile, lstat, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const INSTANCE_JSON = 'instance.json'
const READY_TIMEOUT_MS = 120_000
const READY_POLL_MS = 750
const INSTALL_TIMEOUT_MS = 180_000

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
    this.inflight = new Map()
    this.reservedPorts = new Set([this.hubPort])
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
    const pid = await this.spawn(username, dir, rec.port)
    rec = { ...rec, pid, startedAt: Date.now() }
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
    await writeFile(join(profileDir, 'pnpm-workspace.yaml'),
      'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
    // A regular user's instance runs as root on this host, so the GUI terminal
    // (a root shell for the user) is not exposed: disable the terminal remote
    // (host side, the actual shell launcher) and its sidebar UI (browser side,
    // the 新建终端 entry). Per-user patches added later in this file (e.g. by
    // other plugins) compose with these rows.
    await writeFile(join(profileDir, 'cordis.patch.yml'),
      `# Regular-user instances run as root on the host: no GUI terminals.
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
  async spawn(username, dir, port) {
    const log = await open(join(dir, 'web.log'), 'a')
    const loader = join(this.checkout, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')
    const bin = join(this.checkout, 'apps', 'cli', 'src', 'bin.ts')
    // TSX_TSCONFIG_PATH pins tsx's TypeScript path mappings (workspace
    // packages resolve to their sources through the checkout's tsconfig,
    // exactly like the hub boot does). Without it the instance's cwd has no
    // tsconfig to walk up to, and tsx would load the stale compiled vendor
    // builds instead of the sources the hub runs.
    const child = spawn(process.execPath,
      ['--import', loader, bin, 'web', '--no-open', '--port', String(port)],
      {
        cwd: dir, // defaultCwd (process.cwd()) becomes the user's own directory
        env: {
          ...process.env,
          DSH_HOME: dir,
          TSX_TSCONFIG_PATH: join(this.checkout, 'tsconfig.json'),
        },
        stdio: ['ignore', log.fd, log.fd],
        detached: true,
      })
    child.unref()
    await log.close()
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
