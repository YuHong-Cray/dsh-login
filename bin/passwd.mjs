#!/usr/bin/env node
/**
 * dsh-login — 账号密码诊断与重置（部署侧，只碰账号表）。
 *
 * 回答两个运维问题，都不需要登录界面参与：
 *
 *   node bin/passwd.mjs check tty           # 我输入的密码到底对不对？（只读）
 *   node bin/passwd.mjs set tty             # 用户忘了密码 → 重置（交互确认后写库）
 *   node bin/passwd.mjs check tty --home /root/.dsh
 *
 * `check` 用与本插件登录完全相同的 `verifyPassword` 比对，只打印 ✅/❌：
 * 密码本身既不回显、不写日志，也不离开这台机器。`set` 只 UPDATE
 * `password_hash`，不动账号状态、实例、工作区或既有会话——已经发放的
 * hub 会话与实例内置 cookie 都保持有效。
 *
 * 退出码：0 匹配/已重置，1 不匹配/已取消，2 用法或环境错误。
 */
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { hashPassword, verifyPassword } from '../lib/auth.js'
import { loadConfig } from '../lib/config.js'
import { createLoginDatabase, describeDb } from '../lib/db-driver.js'

const USAGE = `用法：
  node bin/passwd.mjs check <username> [--home <DSH_HOME>]
  node bin/passwd.mjs set <username> [--home <DSH_HOME>] [--yes]

  check  只读：提示输入密码，与账号表里的哈希比对，打印 ✅ / ❌
  set    重置该账号密码（两次输入、不回显；--yes 跳过交互确认）`

/** Read the index-taking flags (--home/--yes) out of argv. */
function splitArgs(argv) {
  const rest = []
  let home
  let yes = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--home') {
      home = argv[i + 1]
      if (home === undefined || home.startsWith('--')) throw new Error('--home 需要一个目录')
      i += 1
      continue
    }
    if (arg === '--yes' || arg === '-y') { yes = true; continue }
    if (arg.startsWith('--')) throw new Error(`未知参数 ${arg}`)
    rest.push(arg)
  }
  return { rest, home, yes }
}

/**
 * Piped-stdin line source. The bytes are read once and queued, so the second
 * prompt of `set` still gets its line instead of hanging on an ended stream.
 */
const piped = { ready: false, ended: false, queue: [], waiting: [] }

function flushPiped() {
  while (piped.waiting.length > 0 && piped.queue.length > 0) piped.waiting.shift()(piped.queue.shift())
}

function pipedLine() {
  if (piped.queue.length > 0) return Promise.resolve(piped.queue.shift())
  if (piped.ended) return Promise.resolve('')
  if (!piped.ready) {
    piped.ready = true
    const stdin = process.stdin
    let buffer = ''
    stdin.setEncoding('utf8')
    stdin.on('data', (chunk) => {
      buffer += chunk
      let idx = buffer.indexOf('\n')
      while (idx >= 0) {
        piped.queue.push(buffer.slice(0, idx).replace(/\r$/u, ''))
        buffer = buffer.slice(idx + 1)
        idx = buffer.indexOf('\n')
      }
      flushPiped()
    })
    stdin.on('end', () => {
      if (buffer.length > 0) piped.queue.push(buffer.replace(/\r$/u, ''))
      piped.ended = true
      flushPiped()
      for (const resolve of piped.waiting.splice(0)) resolve('')
    })
    stdin.on('error', () => {
      piped.ended = true
      for (const resolve of piped.waiting.splice(0)) resolve('')
    })
  }
  return new Promise((resolve) => piped.waiting.push(resolve))
}

/**
 * Ask for a password. On a TTY the input is not echoed; when stdin is a pipe
 * (scripts, tests) one queued line is consumed instead.
 * @param prompt - the text printed before reading.
 * @returns the entered password.
 */
function readPassword(prompt) {
  const stdin = process.stdin
  if (stdin.isTTY !== true) return pipedLine()
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let buffer = ''
    const finish = (value, err) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
      process.stdout.write('\n')
      if (err === undefined) resolve(value)
      else reject(err)
    }
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(buffer)
        if (ch === '\u0003' || ch === '\u0004') return finish('', new Error('已取消'))
        if (ch === '\u007f' || ch === '\b') { buffer = buffer.slice(0, -1); continue }
        if (ch >= ' ') buffer += ch
      }
    }
    stdin.on('data', onData)
  })
}

/**
 * Render an account timestamp. The driver hands back a Date built from the
 * table's literal value, so the local components are what the table shows.
 * @param value - a Date, a datetime string, or null/undefined.
 * @returns `YYYY-MM-DD HH:mm:ss`, or 从未 when the column is empty.
 */
function fmtTime(value) {
  if (value === null || value === undefined) return '从未'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const two = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} `
    + `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}

/** Read one line with echo (the non-secret confirmation prompt). */
async function askYesNo(question) {  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise((resolve) => rl.question(question, resolve))
    return /^(y|yes|是)$/iu.test(answer.trim())
  } finally {
    rl.close()
  }
}

/**
 * Run one subcommand.
 * @param argv - process.argv.slice(2).
 * @returns the exit code.
 */
export async function main(argv) {
  let parsed
  try {
    parsed = splitArgs(argv)
  } catch (err) {
    console.error(`dsh-login passwd: ${err instanceof Error ? err.message : String(err)}`)
    console.error(USAGE)
    return 2
  }
  const [command, username] = parsed.rest
  if (command === undefined || username === undefined) {
    console.error(USAGE)
    return 2
  }
  if (command !== 'check' && command !== 'set') {
    console.error(`未知子命令 ${command}\n${USAGE}`)
    return 2
  }
  const home = parsed.home ?? process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')

  let cfg
  try {
    cfg = loadConfig(home)
  } catch (err) {
    console.error(`读不到 ${home}/dsh-login.json：${err instanceof Error ? err.message : String(err)}`)
    console.error('提示：hub 的 DSH_HOME 通常是 /root/.dsh；用 --home 指定。')
    return 2
  }
  if (cfg.mode === 'instance') {
    console.error(`${home}/dsh-login.json 是 instance 模式（没有账号表）。请对 hub 的 DSH_HOME 运行本工具。`)
    return 2
  }

  let db
  try {
    db = await createLoginDatabase(cfg.db)
  } catch (err) {
    console.error(`连接账号库失败（${describeDb(cfg.db)}）：${err instanceof Error ? err.message : String(err)}`)
    return 2
  }

  try {
    let row
    try {
      row = await db.findByUsername(username)
    } catch (err) {
      console.error(`查询 ${username} 失败：${err instanceof Error ? err.message : String(err)}`)
      return 2
    }
    if (row === undefined) {
      console.error(`❌ 账号 ${username} 不存在（${describeDb(cfg.db)}）`)
      return 1
    }
    // findByUsername returns only the columns the login path needs; the login
    // history comes from listUsers so the report can say whether the hash
    // actually ever verified.
    let account
    try {
      account = (await db.listUsers()).find((it) => it.username === username)
    } catch { /* history is decoration; the hash check is the point */ }
    const meta = `账号状态 ${row.status ?? 'approved'}，上次成功登录 ${fmtTime(account?.last_login_at)}，创建于 ${fmtTime(account?.created_at)}`

    if (command === 'check') {
      const password = await readPassword(`请输入你正在使用的 ${username} 密码（不回显）：`)
      const ok = verifyPassword(password, row.password_hash)
      if (ok) {
        console.log(`✅ 密码匹配。${meta}`)
        console.log('   若这台机器仍登录不上，问题不在密码：请把登录页显示的错误原文发出来。')
        return 0
      }
      console.log(`❌ 密码不匹配。${meta}`)
      console.log('   这就是登录失败的原因（页面上表现为「用户名或密码错误」，连错 10 次后变成「尝试次数过多」）。')
      console.log(`   重置：node bin/passwd.mjs set ${username} --home ${home}`)
      return 1
    }

    console.log(`即将重置账号 ${username}（${meta}）`)
    console.log('只更新 password_hash：账号状态、实例进程、工作区、既有会话都不受影响。')
    if (parsed.yes !== true) {
      const go = await askYesNo('继续？[y/N] ')
      if (!go) {
        console.log('已取消。')
        return 1
      }
    }
    const first = await readPassword('新密码（8-128 位，不回显）：')
    if (first.length < 8 || first.length > 128) {
      console.error('❌ 密码长度需为 8-128 位。')
      return 2
    }
    const again = await readPassword('再输一次：')
    if (first !== again) {
      console.error('❌ 两次输入不一致。')
      return 2
    }
    const result = await db.setPassword(username, hashPassword(first))
    if (result.changed === 0) {
      console.error('❌ 没有更新任何行（账号可能刚被删除）。')
      return 1
    }
    console.log(`✅ 已重置 ${username} 的密码。`)
    console.log('   注意：登录限流是 hub 进程内按来源 IP 记的（15 分钟窗口 / 10 次）；')
    console.log('   若刚才已经连错多次，请等窗口过去，或重启 hub 清空计数。')
    return 0
  } finally {
    try { await db.close?.() } catch { /* best effort */ }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main(process.argv.slice(2))
  process.exit(code)
}
