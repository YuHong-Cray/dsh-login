#!/usr/bin/env node
/**
 * dsh-login — post-deployment acceptance run（部署完成后的验收流程）.
 *
 * Run it on the hub host right after provisioning, before handing the URL to
 * users. It answers one question: 这套部署现在能登录吗？
 *
 *   node bin/verify.mjs                                  # $DSH_HOME (or ~/.dsh)
 *   node bin/verify.mjs --home /root/.dsh --base-url http://127.0.0.1:3080
 *   node bin/verify.mjs --offline                        # provisioning-time check
 *   node bin/verify.mjs --strict                         # warnings also fail
 *
 * Exit code 0 = no failure (warnings allowed unless --strict), 1 = at least one
 * failure. Every failure carries a 修复 hint.
 *
 * What it touches: it creates ONE throwaway account (`dsh-verify-<hex>`), uses
 * it to prove the register → approval → login path, then deletes it. It never
 * modifies an existing account and never logs in a real approved user, because
 * a successful regular-user login provisions a whole tenant instance (30 s to
 * 2 min) — that path is only exercised with the explicit `--with-handoff` flag.
 *
 * Note: the negative login checks consume the login-failure budget of the
 * source IP (10 failures / 15 min per IP in the running hub).
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../lib/config.js'
import { createLoginDatabase, describeDb } from '../lib/db-driver.js'
import { modelPolicyPath, readModelPolicy } from '../lib/model-policy.js'

const SYMBOL = { pass: '✔', fail: '✘', warn: '⚠', info: '·' }

/** Collect one line per check, grouped, with an optional repair hint. */
class Report {
  constructor() {
    this.rows = []
  }

  add(level, group, name, detail = '', hint = '') {
    this.rows.push({ level, group, name, detail, hint })
    return level !== 'fail'
  }

  pass(group, name, detail = '') { return this.add('pass', group, name, detail) }
  warn(group, name, detail = '', hint = '') { return this.add('warn', group, name, detail, hint) }
  fail(group, name, detail = '', hint = '') { return this.add('fail', group, name, detail, hint) }
  info(group, name, detail = '') { return this.add('info', group, name, detail) }

  counts() {
    const out = { pass: 0, fail: 0, warn: 0, info: 0 }
    for (const row of this.rows) out[row.level] += 1
    return out
  }

  print() {
    const lines = []
    let group = ''
    for (const row of this.rows) {
      if (row.group !== group) {
        group = row.group
        lines.push(`\n${group}`)
      }
      const tail = row.detail === '' ? '' : `  ${row.detail}`
      lines.push(`  ${SYMBOL[row.level]} ${row.name}${tail}`)
      if (row.hint !== '') lines.push(`      ↳ 修复: ${row.hint}`)
    }
    return lines.join('\n')
  }
}

/** Parse argv into verify options. Unknown flags are an error, not a shrug. */
export function parseArgs(argv) {
  const opts = {
    home: process.env.DSH_HOME || join(process.env.HOME ?? '', '.dsh'),
    baseUrl: 'http://127.0.0.1:3080',
    offline: false,
    requireHttp: false,
    strict: false,
    instance: '',
    withHandoff: false,
    keepAccount: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} needs a value`)
      return argv[i]
    }
    if (arg === '--home') opts.home = next()
    else if (arg === '--base-url') opts.baseUrl = next()
    else if (arg === '--instance') opts.instance = next()
    else if (arg === '--offline') opts.offline = true
    else if (arg === '--require-http') opts.requireHttp = true
    else if (arg === '--strict') opts.strict = true
    else if (arg === '--with-handoff') opts.withHandoff = true
    else if (arg === '--keep-account') opts.keepAccount = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown option ${arg}`)
  }
  if (opts.home === '' || opts.home === undefined) {
    throw new Error('--home is required (or set DSH_HOME)')
  }
  return opts
}

/** One HTTP call against the running hub/instance; JSON is parsed when present. */
async function httpCall(baseUrl, path, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(new URL(path, baseUrl), {
    method,
    headers: { accept: 'application/json, text/html;q=0.9', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    /* HTML or empty body */
  }
  return { status: res.status, headers: res.headers, text, json }
}

/** Group 1 — the deployment config itself. */
function checkConfig(report, opts) {
  const group = '1. 配置（dsh-login.json）'
  const file = join(opts.home, 'dsh-login.json')
  if (!existsSync(file)) {
    report.fail(group, '配置文件存在', `未找到 ${file}`, '先运行部署（或 cp 一份 dsh-login.json 到 DSH_HOME）')
    return undefined
  }
  let cfg
  try {
    cfg = loadConfig(opts.home)
  } catch (err) {
    report.fail(group, '配置可解析', err instanceof Error ? err.message : String(err), '按报错行修 dsh-login.json，字段名/取值范围是硬校验')
    return undefined
  }
  report.pass(group, '配置文件存在', file)
  if (cfg.instance === true) {
    report.info(group, '模式', 'instance（实例面门禁：本脚本的 hub 检查会跳过）')
    return cfg
  }
  report.pass(group, '模式', 'hub')
  report.info(group, '注册', `register=${cfg.register}, requireApproval=${String(cfg.requireApproval)}`)
  report.info(group, '管理员', (cfg.adminUsers ?? []).join(', ') || '(未配置)')
  report.info(group, '准入网段', (cfg.allowCidrs ?? []).join(', ') || '(默认)')
  report.info(group, '实例根目录', `${cfg.instances.root} (portBase=${cfg.instances.portBase}, isolation=${cfg.instances.isolation})`)
  if (!existsSync(cfg.instances.checkout)) {
    report.fail(group, 'Harness checkout 存在', `未找到 ${cfg.instances.checkout}`, 'instances.checkout 必须指向可安装的 dsh 源码树，否则新用户无法开通实例')
  } else {
    report.pass(group, 'Harness checkout 存在', cfg.instances.checkout)
  }
  if ((cfg.adminUsers ?? []).length === 0) {
    report.warn(group, '管理员名单', 'adminUsers 为空：没有人能进管理台审批新用户', '在 dsh-login.json 里写 adminUsers: ["你的用户名"]')
  }
  if (cfg.requireApproval !== true && cfg.register === 'open') {
    report.warn(group, '审批开关', 'requireApproval 未开启：注册即可用，新用户会直接开通实例', '多租户部署建议 requireApproval: true')
  }
  return cfg
}

/** Group 2 — the account store, including the self-provisioned SQLite file. */
async function checkStore(report, cfg, opts) {
  const group = '2. 账号存储'
  if (cfg === undefined) return undefined
  if (cfg.instance === true) {
    report.info(group, '跳过', '实例面不持有账号表')
    return undefined
  }
  report.info(group, '驱动', describeDb(cfg.db))
  let db
  try {
    db = await createLoginDatabase(cfg.db)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    report.fail(group, '驱动可加载', message, cfg.db.driver === 'mysql'
      ? 'npm install mysql2，或删掉 db.host/db.user/db.database 改用内置 SQLite'
      : '检查 db 配置')
    return undefined
  }
  try {
    const table = await db.ensureTable()
    report.pass(group, '建表/迁移', `表 ${table} 就绪（不存在则自动创建）`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    report.fail(group, '建表/迁移', message, cfg.db.driver === 'mysql'
      ? '确认 MySQL 可达且账号有建表权限（诊断：node test/db-probe.mjs）'
      : '确认 DSH_HOME 可写、文件未被别的进程独占')
    return db
  }
  const health = await db.health()
  if (health === 'up') report.pass(group, '连通性', 'up')
  else report.fail(group, '连通性', 'down', db.lastError || (cfg.db.driver === 'mysql' ? 'node test/db-probe.mjs' : '检查文件与权限'))

  if (cfg.db.driver === 'sqlite') {
    const file = cfg.db.file
    if (!existsSync(file)) {
      report.fail(group, 'SQLite 文件', `未生成 ${file}`, '确认 DSH_HOME 可写后重跑')
    } else {
      const mode = statSync(file).mode & 0o777
      if (mode & 0o077) {
        report.fail(group, 'SQLite 文件权限', `${file} = ${mode.toString(8)}`, `chmod 600 ${file}（表里是口令校验值，必须私有）`)
      } else {
        report.pass(group, 'SQLite 文件权限', `${file} = ${mode.toString(8)}`)
      }
    }
    try {
      accessSync(dirname(file), constants.W_OK)
      report.pass(group, 'SQLite 目录可写', dirname(file))
    } catch {
      report.fail(group, 'SQLite 目录可写', `${dirname(file)} 不可写`, '给 hub 进程对该目录的写权限')
    }
    report.info(group, '迁移到 MySQL', '把 db.host/db.user/db.database 写进 dsh-login.json 即可切换；表结构一致，数据用 mysqldump/导入搬')
  }
  return db
}

/** Group 3 — the browser-session signing secret (survives a hub restart). */
function checkSecret(report, opts) {
  const group = '3. 会话密钥'
  const file = join(opts.home, '.credentials.yaml')
  if (!existsSync(file)) {
    report.warn(group, '.credentials.yaml', `${file} 尚不存在`, '首次登录时由核心写入；在此之前会话 Cookie 无法跨重启')
    return
  }
  const raw = readFileSync(file, 'utf8')
  if (raw.includes('client-connection/browser-session')) {
    report.pass(group, 'browser-session 记录', '会话签名密钥已落盘，hub 重启后 Cookie 仍有效')
  } else {
    report.warn(group, 'browser-session 记录', '未找到该记录', '首次登录 hub 后重跑；否则每次重启都会登出所有人')
  }
}

/** Group 4 — the account table's contents: who can actually log in. */
async function checkAccounts(report, cfg, db) {
  const group = '4. 账号表状态'
  if (db === undefined || cfg?.instance === true) return
  let users
  try {
    users = await db.listUsers()
  } catch (err) {
    report.fail(group, '读取账号列表', err instanceof Error ? err.message : String(err))
    return
  }
  report.info(group, '账号总数', String(users.length))
  const by = (status) => users.filter((u) => (u.status ?? 'approved') === status)
  const approved = by('approved')
  const pending = by('pending')
  const rejected = by('rejected')
  report.info(group, '状态分布', `approved=${approved.length}, pending=${pending.length}, rejected=${rejected.length}`)
  if (users.length === 0) {
    report.warn(group, '空表', '还没有任何账号：先注册管理员账号（adminUsers 里的名字注册后自动 approved）', '打开 /dsh-login/register')
  }
  for (const name of cfg.adminUsers ?? []) {
    const row = users.find((u) => u.username === name)
    if (row === undefined) {
      report.warn(group, `管理员 ${name} 未注册`, 'adminUsers 里有这个名字，但账号表里没有', `用 ${name} 注册一次（管理员注册即 approved）`)
    } else {
      report.pass(group, `管理员 ${name} 已注册`, `status=${row.status ?? 'approved'}`)
    }
  }
  if (pending.length > 0) {
    report.warn(group, '待审批账号', pending.map((u) => u.username).join(', '), '在 /dsh-login/users 审批后才能登录')
  }
  const selfService = users.filter((u) => Number(u.model_self_service ?? 0) === 1)
  report.info(group, '自助配置模型', `${selfService.length}/${users.length} 个账号被允许自助改模型`)
}

/** Group 5 — the running hub over HTTP: the gate, the pages, the CSRF guard. */
async function checkHttp(report, cfg, db, opts) {
  const group = '5. HTTP 门禁（运行中的 hub）'
  if (opts.offline) {
    report.info(group, '跳过', '--offline')
    return
  }
  let health
  try {
    health = await httpCall(opts.baseUrl, '/dsh-login/health')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (opts.requireHttp) {
      report.fail(group, 'hub 可达', `${opts.baseUrl} → ${message}`, '确认 dsh web 已启动、端口正确（--base-url）')
    } else {
      report.warn(group, 'hub 可达', `${opts.baseUrl} → ${message}`, '启动 hub 后重跑，或 --require-http 让它成为硬失败')
    }
    return
  }
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(new URL(opts.baseUrl).hostname)
  report.pass(group, 'hub 可达', `${opts.baseUrl} → ${health.status}`)
  if (health.status === 200 && health.json?.ok === true) {
    report.pass(group, '/dsh-login/health', `db=${health.json.db ?? '?'}`)
    if (health.json.db !== 'up') report.fail(group, '运行中的存储', `db=${health.json.db}`, 'hub 进程连不上账号表：登录会 503')
    if (health.json.dbDriver !== undefined && cfg !== undefined && health.json.dbDriver !== cfg.db.driver) {
      report.warn(group, '存储一致性', `运行中=${health.json.dbDriver}, 配置文件=${cfg.db.driver}`, '改过 dsh-login.json 需要重启 hub 才生效')
    }
  } else {
    report.fail(group, '/dsh-login/health', `HTTP ${health.status}`, '插件未加载或路径被反代改写')
  }

  const state = await httpCall(opts.baseUrl, '/dsh-login/state')
  if (state.status === 200 && typeof state.json?.authenticated === 'boolean') {
    report.pass(group, '/dsh-login/state', `authenticated=${state.json.authenticated}`)
  } else {
    report.fail(group, '/dsh-login/state', `HTTP ${state.status}`)
  }

  const page = await httpCall(opts.baseUrl, '/dsh-login/login')
  const isHtml = String(page.headers.get('content-type') ?? '').includes('text/html')
  if (page.status === 200 && isHtml) report.pass(group, '登录页可渲染', 'HTTP 200 text/html')
  else report.fail(group, '登录页可渲染', `HTTP ${page.status} ${page.headers.get('content-type') ?? ''}`)

  // CSRF guard: a POST whose Origin belongs to another host is refused before
  // any database work. The body is deliberately invalid (a 1-char username), so
  // even a broken guard cannot leave an account behind — it would answer 400.
  const foreign = await httpCall(opts.baseUrl, '/dsh-login/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-login-json': '1', origin: 'http://foreign.example' },
    body: { username: 'x', password: 'probe-probe-probe' },
  })
  if (foreign.status === 403) report.pass(group, '跨站 POST 被拒', '外站 Origin → 403')
  else report.fail(group, '跨站 POST 被拒', `外站 Origin → ${foreign.status}`, 'Origin 校验未生效：检查反代是否改写 Origin/Host')
  report.info(group, '缺失 Origin', '按设计放行（同源表单提交）：这条不作为失败')

  if (isLoopback) {
    report.info(group, '未登录拦截', '回环放行是设计行为：从本机无法验证拦截，请用局域网地址跑 --base-url')
  } else {
    const gate = await httpCall(opts.baseUrl, '/')
    if (gate.status === 302 || gate.status === 303) {
      const location = gate.headers.get('location') ?? ''
      if (location.startsWith('/dsh-login/login')) report.pass(group, '未登录被拦到登录页', `302 → ${location}`)
      else report.warn(group, '未登录跳转目标', `302 → ${location}`, '确认没有反代改写 Location')
    } else {
      report.fail(group, '未登录被拦到登录页', `GET / → ${gate.status}`, '门禁未生效：检查插件是否加载、allowCidrs 是否过宽')
    }
  }

  // The register → approval → login path, on a throwaway account.
  if (cfg?.instance === true || db === undefined) return
  if (cfg.requireApproval !== true) {
    report.warn(group, '注册/审批往返', 'requireApproval 未开启：验收会跳过（注册即登录会直接开通实例）', '要跑这条链路请设 requireApproval: true')
    return
  }
  const tempUser = `dsh-verify-${randomBytes(3).toString('hex')}`
  const tempPassword = `Vfy-${randomBytes(9).toString('hex')}`
  const origin = new URL(opts.baseUrl).origin
  const jsonHeaders = { 'content-type': 'application/json', 'x-dsh-login-json': '1', origin }
  let created = false
  try {
    const reg = await httpCall(opts.baseUrl, '/dsh-login/register', {
      method: 'POST', headers: jsonHeaders, body: { username: tempUser, password: tempPassword },
    })
    created = reg.status === 200 && reg.json?.ok === true
    if (created && reg.json.pending === true) report.pass(group, '注册进审批队列', `${tempUser} → pending`)
    else if (created) report.warn(group, '注册进审批队列', `${tempUser} 注册成功但未 pending`, '确认 requireApproval: true')
    else report.fail(group, '注册往返', `HTTP ${reg.status} ${reg.json?.error ?? ''}`, '注册失败：看 hub 日志与存储状态')

    const dup = await httpCall(opts.baseUrl, '/dsh-login/register', {
      method: 'POST', headers: jsonHeaders, body: { username: tempUser, password: tempPassword },
    })
    if (dup.status === 409) report.pass(group, '重名注册被拒', '同名 → 409')
    else report.warn(group, '重名注册被拒', `同名 → ${dup.status}`)

    const pendingLogin = await httpCall(opts.baseUrl, '/dsh-login/login', {
      method: 'POST', headers: jsonHeaders, body: { username: tempUser, password: tempPassword },
    })
    if (pendingLogin.status === 403) report.pass(group, '未审批不能登录', 'pending → 403')
    else report.fail(group, '未审批不能登录', `HTTP ${pendingLogin.status}`, '审批闸门失效：新用户会绕过审批直接进')

    const badPassword = await httpCall(opts.baseUrl, '/dsh-login/login', {
      method: 'POST', headers: jsonHeaders, body: { username: tempUser, password: `${tempPassword}x` },
    })
    if (badPassword.status === 401) report.pass(group, '口令校验', '错口令 → 401')
    else report.fail(group, '口令校验', `错口令 → ${badPassword.status}`, '口令校验异常：检查 password_hash 是否被外部改写')

    const approved = await db.setStatus(tempUser, 'approved')
    const row = await db.findByUsername(tempUser)
    if (row?.status === 'approved') report.pass(group, '管理员审批写库', `setStatus changed=${approved.changed ?? 0}`)
    else report.fail(group, '管理员审批写库', `status=${row?.status ?? 'missing'}`, '写库失败：检查存储权限')

    if (opts.withHandoff) {
      const ok = await httpCall(opts.baseUrl, '/dsh-login/login', {
        method: 'POST', headers: jsonHeaders, body: { username: tempUser, password: tempPassword },
      })
      const location = ok.headers.get('location') ?? ''
      if (ok.status === 302 || ok.status === 303) {
        report.pass(group, '普通用户开通实例（--with-handoff）', `${ok.status} → ${location}`)
        report.warn(group, '已创建实例', `${tempUser} 的实例已开通，验收不会删除它`, `删除 ${cfg.instances.root}/${tempUser} 并停掉其进程`)
      } else {
        report.fail(group, '普通用户开通实例', `HTTP ${ok.status} ${ok.json?.error ?? ''}`, '看 hub 日志：provision 失败通常是 pnpm install 或 uid 隔离问题')
      }
    } else {
      report.info(group, '成功登录 → 开通实例', '未验证（会真的开通一个租户实例，30s–2min）；需要时加 --with-handoff')
    }
  } finally {
    if (created && !opts.keepAccount) {
      try {
        await db.remove(tempUser)
        report.pass(group, '清理临时账号', tempUser)
      } catch (err) {
        report.warn(group, '清理临时账号', `${tempUser}: ${err instanceof Error ? err.message : String(err)}`, `手动删除：DELETE FROM ${cfg.db.table} WHERE username='${tempUser}'`)
      }
    } else if (opts.keepAccount) {
      report.info(group, '保留临时账号', `--keep-account：${tempUser}`)
    }
  }
}

/** Group 6 — each provisioned tenant instance (read-only). */
async function checkInstances(report, cfg, db, opts) {
  const group = '6. 实例面（已开通的租户）'
  if (cfg?.instance === true || cfg?.instances === undefined) {
    report.info(group, '跳过', 'hub 未配置 instances')
    return
  }
  let entries
  try {
    entries = await readdir(cfg.instances.root, { withFileTypes: true })
  } catch (err) {
    report.info(group, '尚无租户', `${cfg.instances.root}: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  const names = entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name)
  const wanted = opts.instance === '' ? names : names.filter((n) => n === opts.instance)
  if (wanted.length === 0) {
    report.info(group, '尚无租户', opts.instance === '' ? '第一个普通用户登录时会自动开通' : `未找到租户 ${opts.instance}`)
    return
  }
  const users = db === undefined ? [] : await db.listUsers().catch(() => [])
  for (const name of wanted) {
    const dir = join(cfg.instances.root, name)
    let instanceJson
    try {
      instanceJson = JSON.parse(readFileSync(join(dir, 'instance.json'), 'utf8'))
    } catch {
      report.warn(group, `${name}: instance.json`, '缺失或不可解析', '该目录不会被 hub 认领；下次登录会重新 provision')
      continue
    }
    report.pass(group, `${name}: 已开通`, `port=${instanceJson.port}`)
    let instanceCfg
    try {
      instanceCfg = loadConfig(dir)
    } catch (err) {
      report.fail(group, `${name}: 实例配置`, err instanceof Error ? err.message : String(err), '修该目录下的 dsh-login.json')
      continue
    }
    if (instanceCfg.instance !== true) report.fail(group, `${name}: 实例模式`, 'dsh-login.json 缺少 instance: true')
    else report.pass(group, `${name}: 实例门禁已启用`, `port=${instanceCfg.port ?? instanceJson.port}`)
    if (!existsSync(join(dir, '.credentials.yaml'))) {
      report.warn(group, `${name}: 会话密钥`, '缺 .credentials.yaml', 'provision 应写入；缺失会导致该实例每次重启都登出')
    }
    const profilePkg = join(dir, 'profiles', 'web', 'package.json')
    if (!existsSync(profilePkg)) {
      report.fail(group, `${name}: profile 已安装`, `缺 ${profilePkg}`, `cd ${dir}/profiles/web && pnpm install`)
    } else {
      report.pass(group, `${name}: profile 已安装`, profilePkg)
    }
    // The self-service decision must agree between the hub's table and the
    // mirror file the instance reads.
    const row = users.find((u) => u.username === name)
    if (row !== undefined) {
      const mirror = await readModelPolicy(dir)
      const expected = Number(row.model_self_service ?? 0) === 1
      if (mirror === expected) report.pass(group, `${name}: 模型自助开关一致`, String(expected))
      else report.warn(group, `${name}: 模型自助开关不一致`, `表=${expected}, 镜像=${mirror} (${modelPolicyPath(dir)})`, '在管理台重新拨一次开关即可重写镜像')
    }
    if (opts.offline) continue
    const port = instanceJson.port
    try {
      const health = await httpCall(`http://127.0.0.1:${port}`, '/dsh-login/health')
      if (health.status === 200 && health.json?.ok === true) report.pass(group, `${name}: 实例在跑`, `127.0.0.1:${port} → ok`)
      else report.warn(group, `${name}: 实例健康`, `127.0.0.1:${port} → HTTP ${health.status}`)
    } catch {
      report.warn(group, `${name}: 实例未在跑`, `127.0.0.1:${port} 不可达`, 'hub 会在下次登录时重新拉起；也可在管理台点“重启”')
    }
  }
}

/** Group 7 — OS-level isolation posture (uid mode). */
async function checkIsolation(report, cfg) {
  const group = '7. 隔离与权限'
  if (cfg?.instance === true || cfg?.instances === undefined) return
  if (cfg.instances.isolation !== 'uid') {
    report.warn(group, '隔离模式', 'isolation=none：实例以 root 运行，租户之间没有 OS 隔离', '生产环境请设 instances.isolation: "uid"')
    return
  }
  let st
  try {
    st = statSync(cfg.instances.root)
  } catch {
    report.warn(group, '实例根目录存在', `未找到 ${cfg.instances.root}`, '首个普通用户登录时会自动创建；也可提前 mkdir + chown root:root 755')
    return
  }
  if (st.uid !== 0) report.warn(group, '实例根目录属主', `${cfg.instances.root} uid=${st.uid}（应为 root）`, 'chown root:root 该目录，否则租户能改别人的目录')
  else report.pass(group, '实例根目录属主', `${cfg.instances.root} = root`)
  if ((st.mode & 0o777) > 0o755) report.warn(group, '实例根目录权限', `${(st.mode & 0o777).toString(8)}`, 'chmod 755：租户主目录由各自 uid 持有，根目录不需要更宽')
  if (cfg.instances.root.startsWith('/root/')) {
    report.fail(group, '实例根目录位置', `${cfg.instances.root} 在 /root 下`, 'uid 隔离的租户需要穿越该路径：把 instances.root 移到 /srv 之类')
  } else {
    report.pass(group, '实例根目录位置', cfg.instances.root)
  }
  const entries = await readdir(cfg.instances.root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(cfg.instances.root, entry.name)
    const dst = statSync(dir)
    if (dst.uid === 0) {
      report.warn(group, `${entry.name}: 主目录属主`, '仍是 root', 'chown -R 到该租户的 uid（provision 会做；手工建目录时容易漏）')
    } else {
      report.pass(group, `${entry.name}: 主目录属主`, `uid=${dst.uid}`)
    }
  }
}

export const USAGE = `用法: node bin/verify.mjs [选项]

  --home <DSH_HOME>     hub 的 DSH_HOME（默认 $DSH_HOME，否则 ~/.dsh）
  --base-url <url>      运行中的 hub 地址（默认 http://127.0.0.1:3080）
  --offline             只查落盘状态，不发 HTTP
  --require-http        hub 不可达算失败（默认算警告）
  --strict              警告也算失败
  --instance <user>     只检查这一个租户实例
  --with-handoff        额外验证“普通用户登录 → 开通实例”（会真的开通一个实例）
  --keep-account        保留验收用的临时账号（默认删除）
`

/** Run the whole acceptance flow. Returns { exitCode, counts, output }. */
export async function runVerify(options = {}) {
  const opts = { ...parseArgs([]), ...options }
  const report = new Report()
  const cfg = checkConfig(report, opts)
  const db = await checkStore(report, cfg, opts)
  if (cfg?.instance !== true) checkSecret(report, opts)
  await checkAccounts(report, cfg, db)
  await checkHttp(report, cfg, db, opts)
  await checkInstances(report, cfg, db, opts)
  await checkIsolation(report, cfg)
  if (db !== undefined) db.close()
  const counts = report.counts()
  const failed = counts.fail > 0 || (opts.strict && counts.warn > 0)
  return { exitCode: failed ? 1 : 0, counts, output: report.print() }
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`dsh-login verify: ${err instanceof Error ? err.message : String(err)}`)
    console.error(USAGE)
    process.exitCode = 2
    return
  }
  if (opts.help) {
    console.log(USAGE)
    return
  }
  console.log(`dsh-login 验收 · home=${opts.home} · base-url=${opts.baseUrl}${opts.offline ? ' · offline' : ''}`)
  const result = await runVerify(opts)
  console.log(result.output)
  const { pass, fail, warn, info } = result.counts
  console.log(`\n结果: ${pass} 通过 · ${warn} 警告 · ${fail} 失败${info ? ` · ${info} 说明` : ''}`)
  console.log(result.exitCode === 0
    ? '验收通过：这套 dsh-login 可以登录使用了。'
    : '验收未通过：按上面的 修复 提示处理后重跑。')
  process.exitCode = result.exitCode
}

// Importable by the test suite; only a direct run drives the process exit code.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
