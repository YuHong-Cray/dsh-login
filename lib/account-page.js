/**
 * dsh-login — server-rendered account / user-management pages.
 *
 * Three pages share one compact dark theme (no JS required except the
 * delete action on the users page):
 *
 *   renderAccountPage       — "who am I / my environment / logout", shown
 *                             for a hub session (admin or regular) or from
 *                             inside a user instance.
 *   renderUsersPage         — the admin-only user management console.
 *   renderEnterConfirmPage  — two-step confirmation for "enter as this
 *                             user": the GET renders this page, the POST
 *                             performs the handoff.
 *   renderMyModelsPage      — the user self-service model page
 *                             (`/dsh-login/models`, instance mode).
 */

import { KNOWN_APIS, listPresets, presetById } from './provider-presets.js'

const THEME = `
:root{--bg:#0b0e14;--card:#12161f;--card2:#0f131b;--line:#232a38;--text:#e8ecf4;--muted:#9aa4b8;--faint:#5f6b82;--accent:#5b8cff;--danger:#ff6b6b;--ok:#3ecf8e}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font:14px/1.55 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;display:flex;flex-direction:column;align-items:center;padding:32px 16px}
.card{width:100%;max-width:960px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:22px 24px}
h1{font-size:17px;margin:0 0 4px}
.sub{color:var(--muted);font-size:12.5px;margin:0 0 18px}
.row{display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--line);flex-wrap:wrap}
.row:last-child{border-bottom:none}
.row label{color:var(--muted);min-width:110px;flex:0 0 auto;margin:0}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11.5px;border:1px solid var(--line);color:var(--muted)}
.badge.admin{color:#ffd479;border-color:#4d3d1f}
.badge.ok{color:var(--ok);border-color:#1f4d38}
.badge.down{color:var(--danger);border-color:#4d1f1f}
a.btn,button.btn{display:inline-block;background:var(--card2);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:5px 12px;font-size:12.5px;cursor:pointer;text-decoration:none;font-family:inherit}
a.btn:hover,button.btn:hover{border-color:var(--accent)}
a.btn.primary,button.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
a.btn.danger,button.btn.danger{color:var(--danger)}
a.btn.danger:hover,button.btn.danger:hover{border-color:var(--danger)}
button:disabled{opacity:.5;cursor:not-allowed}
table{width:100%;border-collapse:collapse;font-size:13px}
th{color:var(--faint);font-weight:600;text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-size:11.5px}
td{padding:9px 10px;border-bottom:1px solid var(--line)}
td.actions{white-space:nowrap}
td.actions a,td.actions button{margin-right:6px}
.alert{background:#2a1518;border:1px solid #5d2530;color:#ffb4c0;border-radius:8px;padding:9px 12px;font-size:13px;margin-bottom:14px}
.note{color:var(--faint);font-size:12px;margin-top:16px;line-height:1.7}
.mono{font-family:ui-monospace,monospace;font-size:12px;color:var(--muted)}
`

function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function shell(title, subtitle, body, note) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${THEME}</style>
</head>
<body>
<main class="card">
<h1>${esc(title)}</h1>
<p class="sub">${esc(subtitle)}</p>
${body}
${note !== undefined ? `<p class="note">${note}</p>` : ''}
</main>
</body>
</html>
`
}

/**
 * The account page: current identity, (hub regular user) own instance,
 * (instance) own port, and logout.
 * @param opts.mode - 'hub' | 'instance'.
 * @param opts.username - session username (hub, authenticated) or undefined.
 * @param opts.admin - true for an admin session (hub).
 * @param opts.port - instance port (hub regular / instance), 0 = unknown.
 * @param opts.running - instance liveness (hub regular), undefined = n/a.
 * @param opts.instanceHost - request host without port, for the instance URL.
 * @param opts.error - optional error banner.
 */
export function renderAccountPage({ mode, username, admin, port, running, instanceHost, error }) {
  const errHtml = error ? `<div class="alert" role="alert">${esc(error)}</div>` : ''
  if (mode === 'instance') {
    const body = `
${errHtml}
<div class="row"><label>当前环境</label><span>独立实例</span>${port > 0 ? ` <span class="badge ok">端口 ${String(port)}</span>` : '<span class="badge">端口未知</span>'}</div>
<div class="row"><label>模型管理</label><a class="btn" href="/dsh-login/models">我的模型（添加 / 删除 provider 与 API key）</a></div>
<div class="row"><label></label><a class="btn" href="/dsh-login/logout">退出登录</a></div>
`
    return shell('账户中心 · 独立环境', '本页由 dsh-login 门禁提供；退出后返回 hub 登录页，重新登录即回到本环境。', body)
  }
  if (username === undefined) {
    return shell('账户中心', '尚未登录。', `${errHtml}
<div class="row"><label></label><a class="btn primary" href="/dsh-login/login">前往登录页</a></div>`)
  }
  const badge = admin ? '<span class="badge admin">管理员</span>' : '<span class="badge">普通用户</span>'
  let instanceRow = ''
  if (!admin && port > 0) {
    const state = running ? '<span class="badge ok">运行中</span>' : '<span class="badge down">启动中 / 离线</span>'
    instanceRow = `<div class="row"><label>独立环境</label><a class="mono" href="http://${esc(instanceHost)}:${String(port)}/" target="_blank" rel="noopener">http://${esc(instanceHost)}:${String(port)}/</a> ${state} <a class="btn" href="http://${esc(instanceHost)}:${String(port)}/" target="_blank" rel="noopener">打开</a></div>`
  } else if (!admin) {
    instanceRow = '<div class="row"><label>独立环境</label><span style="color:var(--muted)">正在供给中，请稍后刷新本页</span></div>'
  }
  const body = `
${errHtml}
<div class="row"><label>当前登录</label><strong>${esc(username)}</strong> ${badge}</div>
${instanceRow}
<div class="row"><label></label>${admin ? '<a class="btn primary" href="/dsh-login/users">用户管理</a> ' : ''}<a class="btn" href="/dsh-login/logout">退出登录</a> <a class="btn" href="/">进入应用</a></div>
`
  return shell('账户中心', '本页由 dsh-login 门禁提供；退出当前会话后可在本页切换登录其他账号。', body)
}

/**
 * The admin user-management console.
 * @param opts.users - [{username, admin, status, port, running, createdAt, lastLoginAt}].
 * @param opts.self - the requesting admin's username (self-delete is blocked).
 * @param opts.instanceHost - request host without port, for instance URLs.
 * @param opts.error - optional error banner.
 */
export function renderUsersPage({ users, self, instanceHost, error }) {
  const errHtml = error ? `<div class="alert" role="alert">${esc(error)}</div>` : ''
  const pendingCount = users.filter((u) => !u.admin && u.status === 'pending').length
  const pendingHint = pendingCount > 0
    ? `<div class="alert warn" role="alert">有 ${String(pendingCount)} 个账号等待审批：在下方「状态」列点「通过」后，该账号才能登录。</div>`
    : ''
  const rows = users.map((u) => {
    const isSelf = u.username === self
    const status = u.admin ? 'approved' : (u.status ?? 'approved')
    const statusCell = status === 'pending'
      ? '<span class="badge down">待审批</span>'
      : status === 'rejected' ? '<span class="badge down">已拒绝</span>' : '<span class="badge ok">已通过</span>'
    const portCell = u.port > 0 ? String(u.port) : '<span style="color:var(--faint)">—</span>'
    const runCell = u.port === 0
      ? '<span style="color:var(--faint)">未供给</span>'
      : u.running ? '<span class="badge ok">运行中</span>' : '<span class="badge down">离线</span>'
    const enterBtn = u.admin
      ? ''
      : `<a class="btn" href="/dsh-login/enter?user=${encodeURIComponent(u.username)}">以该用户进入</a>`
    const openBtn = u.port > 0
      ? `<a class="btn" href="http://${esc(instanceHost)}:${String(u.port)}/" target="_blank" rel="noopener">打开</a>`
      : ''
    const delBtn = isSelf
      ? '<button class="btn danger" disabled title="不能删除自己的账号">删除</button>'
      : `<button class="btn danger" data-del="${esc(u.username)}" data-port="${u.port > 0 ? String(u.port) : '?'}">删除</button>`
    const modelBtn = u.admin
      ? ''
      : `<a class="btn" href="/dsh-login/users/models?user=${encodeURIComponent(u.username)}">模型</a>`
    const approveBtn = !u.admin && status !== 'approved'
      ? `<button class="btn primary" data-status="approve" data-user="${esc(u.username)}">通过</button>`
      : ''
    const rejectBtn = !u.admin && status !== 'rejected'
      ? `<button class="btn danger" data-status="reject" data-user="${esc(u.username)}">拒绝</button>`
      : ''
    return `<tr>
<td><strong>${esc(u.username)}</strong></td>
<td>${u.admin ? '<span class="badge admin">管理员</span>' : '<span class="badge">普通用户</span>'}</td>
<td>${statusCell}</td>
<td class="mono">${portCell}</td>
<td>${runCell}</td>
<td class="mono">${esc(u.createdAt ?? '—')}</td>
<td class="mono">${esc(u.lastLoginAt ?? '从未')}</td>
<td class="actions">${approveBtn}${rejectBtn}${enterBtn}${openBtn}${modelBtn}${delBtn}</td>
</tr>`
  }).join('\n')
  const body = `
${errHtml}${pendingHint}
<table>
<thead><tr><th>账号</th><th>角色</th><th>状态</th><th>实例端口</th><th>实例状态</th><th>创建时间</th><th>最近登录</th><th>操作</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<script>
document.querySelectorAll('button[data-del]').forEach(function (btn) {
  btn.addEventListener('click', async function () {
    var u = btn.getAttribute('data-del')
    var port = btn.getAttribute('data-port')
    if (!window.confirm('确认删除用户 "' + u + '"？\\n将停止并删除其独立环境（端口 ' + port + '），并从数据库删除该账号。\\n此操作不可恢复。')) return
    btn.disabled = true
    try {
      var res = await fetch('/dsh-login/users/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user: u }),
      })
      var data = await res.json().catch(function () { return {} })
      if (!res.ok) { window.alert('删除失败：' + (data.error || res.status)); btn.disabled = false; return }
      location.reload()
    } catch (e) { window.alert('删除失败：' + String(e)); btn.disabled = false }
  })
})
document.querySelectorAll('button[data-status]').forEach(function (btn) {
  btn.addEventListener('click', async function () {
    var u = btn.getAttribute('data-user')
    var action = btn.getAttribute('data-status')
    var word = action === 'approve' ? '通过' : '拒绝'
    if (action === 'reject' && !window.confirm('确认拒绝账号 "' + u + '"？\\n被拒绝的账号将无法登录，之后仍可通过「通过」恢复。')) return
    btn.disabled = true
    try {
      var res = await fetch('/dsh-login/users/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user: u, action: action }),
      })
      var data = await res.json().catch(function () { return {} })
      if (!res.ok) { window.alert(word + '失败：' + (data.error || res.status)); btn.disabled = false; return }
      location.reload()
    } catch (e) { window.alert(word + '失败：' + String(e)); btn.disabled = false }
  })
})
</script>
`
  const note = '「通过 / 拒绝」是账号审批：新注册的账号默认「待审批」，审批通过后才能登录（管理员账号不受审批约束）。'
    + '「以该用户进入」：进入后本浏览器会自动登录该用户的实例环境；hub 上的身份保持不变。'
    + '「模型」为该用户配置模型 provider；「删除」会停止并删除其独立环境（/root/dsh-users/ 下对应目录）并从数据库删除账号。'
  return shell('用户管理', 'dsh-login · 仅管理员可见。用户账号存于数据库；独立环境目录 /root/dsh-users/<用户名>。', body, note)
}

/**
 * Two-step confirmation for entering a user's instance as the admin.
 */
export function renderEnterConfirmPage({ user, port, running }) {
  const portText = port > 0 ? String(port) : '—'
  const warn = running
    ? ''
    : '<div class="alert" role="alert">该用户的实例当前未在运行，进入时将触发（重新）启动，首次最多需要约 2 分钟。</div>'
  const body = `
${warn}
<div class="row"><label>目标用户</label><strong>${esc(user)}</strong> <span class="badge">普通用户</span></div>
<div class="row"><label>实例端口</label><span class="mono">${portText}</span></div>
<div class="row"><label></label>
<form method="post" action="/dsh-login/enter" style="display:flex;gap:8px">
<input type="hidden" name="user" value="${esc(user)}">
<button class="btn primary" type="submit">确认进入</button>
<a class="btn" href="/dsh-login/users">取消</a>
</form></div>
`
  const note = '进入后本浏览器将自动登录该用户的独立实例（30 天有效）；你在 hub 上的登录身份不受影响。'
  return shell(`进入 ${esc(user)} 的环境`, 'dsh-login · 管理员操作', body, note)
}

/**
 * Admin console: configure one user's OWN model provider.
 *
 * Writes go to that user's own `settings.yaml` / `.credentials.yaml` (their
 * DSH_HOME), through their instance's own API — never to the hub's settings.
 * @param opts.user - target username.
 * @param opts.port - the user's instance port (0 when never provisioned).
 * @param opts.running - whether the instance is currently answering.
 * @param opts.providers - already configured providers: [{id, api, baseURL, apiKeyEnv, models[]}].
 * @param opts.defaultModel - current `{provider, model}` selection, if any.
 * @param opts.error - optional error banner.
 * @param opts.ok - optional success banner.
 * @param opts.readError - optional warning about reading the current config.
 * @param opts.form - last submitted values, echoed back after a failed save so
 *   the administrator does not have to retype them (the API key is never echoed).
 */
export function renderUserModelsPage({ user, port, running, providers, defaultModel, error, ok, readError, form }) {
  const errHtml = error ? `<div class="alert error" role="alert">${esc(error)}</div>` : ''
  const okHtml = ok ? `<div class="alert ok" role="alert">${esc(ok)}</div>` : ''
  const readHtml = readError ? `<div class="alert warn" role="alert">${esc(readError)}</div>` : ''
  const submitted = form !== null && typeof form === 'object' ? form : {}
  const value = (name) => {
    const raw = submitted[name]
    return esc(typeof raw === 'string' ? raw.trim() : '')
  }
  const checked = (() => {
    const raw = submitted.setDefault
    return raw === true || raw === 'true' || raw === 'on' ? ' checked' : ''
  })()
  const state = port === 0
    ? '<span class="badge down">尚未供给（保存时会自动创建，首次约 30 秒~2 分钟）</span>'
    : running ? '<span class="badge ok">运行中</span>' : '<span class="badge down">离线（保存时会自动启动）</span>'
  const rows = providers.length === 0
    ? '<tr><td colspan="4" style="color:var(--muted)">该用户还没有配置任何 provider</td></tr>'
    : providers.map((p) => `<tr>
<td class="mono">${esc(p.id)}${defaultModel?.provider === p.id ? ' <span class="badge ok">默认</span>' : ''}</td>
<td class="mono">${esc(p.api || '—')}</td>
<td class="mono">${esc(p.baseURL || '—')}</td>
<td class="mono">${p.models.length > 0 ? esc(p.models.join(', ')) : '—'}${p.apiKeyEnv ? ` <span style="color:var(--faint)">key:${esc(p.apiKeyEnv)}</span>` : ''}</td>
</tr>`).join('\n')
  const defaultLine = defaultModel
    ? `<div class="row"><label>当前默认模型</label><span class="mono">${esc(defaultModel.provider)} / ${esc(defaultModel.model)}</span></div>`
    : '<div class="row"><label>当前默认模型</label><span style="color:var(--muted)">未设置</span></div>'
  const body = `
${errHtml}${okHtml}${readHtml}
<div class="row"><label>目标用户</label><strong>${esc(user)}</strong> <span class="badge">普通用户</span></div>
<div class="row"><label>实例状态</label><span class="mono">端口 ${port > 0 ? String(port) : '—'}</span> ${state}</div>
${defaultLine}
<h3 style="margin:18px 0 8px;font-size:14px">已配置的 provider</h3>
<table>
<thead><tr><th>标识</th><th>api</th><th>baseURL</th><th>模型</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<h3 style="margin:20px 0 8px;font-size:14px">新增 / 覆盖 provider</h3>
<form method="post" action="/dsh-login/users/models?user=${esc(encodeURIComponent(user))}">
<input type="hidden" name="user" value="${esc(user)}">
<div class="row"><label for="providerId">provider 标识</label><input id="providerId" name="providerId" value="${value('providerId')}" placeholder="例如 my-gw（小写字母/数字/连字符）" required></div>
<div class="row"><label for="api">api 类型</label><input id="api" name="api" value="${value('api')}" list="api-types" placeholder="openai-completions"><datalist id="api-types"><option value="openai-completions"></option><option value="openai-responses"></option><option value="anthropic-messages"></option><option value="google-generative-ai"></option></datalist></div>
<div class="row"><label for="baseURL">baseURL</label><input id="baseURL" name="baseURL" value="${value('baseURL')}" placeholder="http://10.0.0.17:8000/v1" required></div>
<div class="row"><label for="modelId">模型 ID</label><input id="modelId" name="modelId" value="${value('modelId')}" placeholder="/mnt/data/models/Qwen3.8-27B" required></div>
<div class="row"><label for="modelName">显示名（可选）</label><input id="modelName" name="modelName" value="${value('modelName')}" placeholder="留空则与模型 ID 相同"></div>
<div class="row"><label for="apiKey">API key（可选）</label><input id="apiKey" name="apiKey" type="password" autocomplete="new-password" placeholder="留空表示不修改已存的 key"></div>
<div class="row"><label></label><label style="color:var(--muted);font-size:12.5px"><input type="checkbox" name="setDefault" value="true"${checked}> 同时设为该用户的默认模型</label></div>
<div class="row"><label></label><button class="btn primary" type="submit">保存到该用户环境</button> <a class="btn" href="/dsh-login/users">返回用户管理</a></div>
</form>
`
  const note = '写入的是该用户自己 DSH_HOME 下的 settings.yaml 与 .credentials.yaml（保留其登录签名记录），不修改 hub 或任何其他用户；保存后其 GUI 会热加载新的模型目录。'
    + 'STP 明确规定非 loopback 页面不得编辑 host 设置，所以 LAN 下用户无法使用原生「设置 → 模型」页，这里由管理员代为写入同一套受校验的写入接口。'
  return shell(`配置 ${esc(user)} 的模型`, 'dsh-login · 管理员操作', body, note)
}

/**
 * The user self-service model page (`/dsh-login/models`, instance mode).
 *
 * One card: the configured providers (key state + set-default + delete), and
 * the add form — a model-company preset (paste the key, everything else comes
 * from the installed pi-ai catalog) or a custom route. The page never echoes
 * an API key back: the key field renders empty on every re-render, and the
 * form echo carries only the non-secret fields.
 *
 * The small script (no dependencies) does what a static page cannot: load a
 * catalog route's model list for the set-default selects (the plugin answers
 * it from the installed catalog without a network call), prefill the custom
 * form's model select from the typed ids, and gate the two JSON actions
 * (delete / set-default) behind a confirm and a loaded model select.
 *
 * @param opts.port - the instance port (display only).
 * @param opts.providers - configured providers from `summarizeModelConfig`,
 *   each enriched with `keyConfigured` (boolean | undefined = unknown) for
 *   rows whose profile names a credential reference.
 * @param opts.defaultModel - current `{provider, model}`, if any.
 * @param opts.error - validation/write error banner.
 * @param opts.ok - success banner.
 * @param opts.readError - `settings/describe` failure banner.
 * @param opts.form - echoed submit (kind/presetId/providerId/displayName/
 *   api/baseURL/models/setDefault/defaultModel); the key is never part of it.
 */
export function renderMyModelsPage({ port, providers, defaultModel, error, ok, readError, form }) {
  const errHtml = error ? `<div class="alert error" role="alert">${esc(error)}</div>` : ''
  const okHtml = ok ? `<div class="alert ok" role="alert">${esc(ok)}</div>` : ''
  const readHtml = readError ? `<div class="alert warn" role="alert">${esc(readError)}</div>` : ''
  const submitted = form !== null && typeof form === 'object' ? form : {}
  const value = (name) => {
    const raw = submitted[name]
    return esc(typeof raw === 'string' ? raw : '')
  }
  const checked = (() => {
    const raw = submitted.setDefault
    return raw === true || raw === 'true' || raw === 'on' ? ' checked' : ''
  })()
  const echoKind = submitted.kind === 'preset' ? 'preset' : submitted.kind === 'custom' ? 'custom' : ''
  const echoPreset = presetById(typeof submitted.presetId === 'string' ? submitted.presetId : '')
  const echoPresetShown = echoKind === 'preset' && echoPreset !== undefined
  const echoCustomShown = echoKind === 'custom'

  const rows = providers.length === 0
    ? '<tr><td colspan="7" style="color:var(--muted)">还没有配置 provider：在下方选择模型公司，粘贴 API key 即可。</td></tr>'
    : providers.map((p) => {
      const isDefault = defaultModel?.provider === p.id
      const keyBadge = p.apiKeyEnv === undefined || p.apiKeyEnv === ''
        ? '<span class="badge">原生鉴权</span>'
        : p.keyConfigured === true
          ? '<span class="badge ok">已配置</span>'
          : p.keyConfigured === false
            ? '<span class="badge down">未配置</span>'
            : '<span class="badge">状态未知</span>'
      const knownModels = Array.isArray(p.models) ? p.models.filter((m) => typeof m === 'string' && m !== '') : []
      const options = knownModels.length > 0
        ? '<option value="">选择模型</option>' + knownModels.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('')
        : ''
      const setDefaultCell = isDefault
        ? '<span class="badge ok">默认</span>'
        : `<span class="df-slot" data-provider="${esc(p.id)}"><select class="df-model"${knownModels.length > 0 ? ' data-loaded="1"' : ''}>${options}</select></span><button class="btn" data-df="${esc(p.id)}" type="button">设为默认</button>`
      return `<tr>
<td><strong>${esc(p.id)}</strong>${p.displayName !== undefined && p.displayName !== p.id ? ` <span style="color:var(--faint)">${esc(p.displayName)}</span>` : ''}</td>
<td>${p.baseURL !== undefined && p.baseURL !== '' ? '自定义' : '内置'}</td>
<td class="mono">${p.baseURL !== undefined && p.baseURL !== '' ? esc(p.baseURL) : '目录默认'}</td>
<td class="mono">${p.api !== undefined && p.api !== '' ? esc(p.api) : '目录默认'}</td>
<td class="mono">${knownModels.length > 0 ? esc(knownModels.join(', ')) : '目录默认'}</td>
<td>${keyBadge}</td>
<td class="actions">${setDefaultCell}<button class="btn danger" data-del="${esc(p.id)}" type="button">删除</button></td>
</tr>`
    }).join('\n')

  const presetButtons = (list) => list.map((p) =>
    `<button type="button" class="btn preset"${echoPresetShown && echoPreset.id === p.id ? ' primary' : ''} data-preset="${esc(p.id)}">${esc(p.name)}</button>`,
  ).join(' ')
  const commonPresets = listPresets().filter((p) => p.common)
  const otherPresets = listPresets().filter((p) => !p.common)
  const presetsJson = Object.fromEntries(
    listPresets().map((p) => [p.id, { name: p.name, api: p.api, baseUrl: p.baseUrl, model: p.model, keyUrl: p.keyUrl ?? '' }]),
  )

  const apiOptions = KNOWN_APIS.map((api) => `<option value="${esc(api)}"${submitted.api === api ? ' selected' : ''}>${esc(api)}</option>`).join('')
  const customActiveBtn = echoCustomShown ? ' primary' : ''

  const body = `
${errHtml}${okHtml}${readHtml}
<div class="row"><label>当前默认模型</label>${defaultModel
    ? `<span class="mono">${esc(defaultModel.provider)} / ${esc(defaultModel.model)}</span>`
    : '<span style="color:var(--muted)">未设置（不设置时需在会话里手动选模型）</span>'}</div>
<h3 style="margin:18px 0 8px;font-size:14px">已配置的 provider</h3>
<table>
<thead><tr><th>标识</th><th>类型</th><th>地址</th><th>协议</th><th>模型</th><th>API key</th><th></th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<h3 style="margin:20px 0 8px;font-size:14px">添加提供方（选择模型公司，粘贴它官网签发的 API key）</h3>
<p style="color:var(--muted);margin:0 0 10px">内置提供方无需填写地址 / 协议 / 模型（使用 DeepSeek Harness 内置目录）；目录外的公司（阿里百炼 DashScope、火山方舟、自建 vLLM / Ollama / 中转网关）选「自定义」。</p>
<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px">
${presetButtons(commonPresets)}
<details style="display:inline-block"><summary class="btn" style="list-style:none">更多内置提供方</summary>
<div style="display:flex;flex-wrap:wrap;gap:8px;padding-top:8px">${presetButtons(otherPresets)}</div>
</details>
<button type="button" class="btn preset"${customActiveBtn} data-preset="__custom__">自定义（其他 / 自建 / 中转）</button>
</div>
<div id="add-hint" style="color:var(--faint);font-size:12.5px;margin:0 0 10px;${(echoPresetShown || echoCustomShown) ? 'display:none' : ''}">点击上方任意模型公司或「自定义」开始。</div>
<form id="add-form" method="post" action="/dsh-login/models"${(echoPresetShown || echoCustomShown) ? '' : ' hidden'}>
<input type="hidden" name="kind" id="add-kind" value="${echoKind}">
<input type="hidden" name="presetId" id="add-presetId" value="${esc(typeof submitted.presetId === 'string' ? submitted.presetId : '')}">
<div id="preset-panel" style="border:1px solid var(--line);border-radius:10px;padding:6px 14px;margin-bottom:12px;${echoPresetShown ? '' : 'display:none'}">
<div class="row"><label>模型公司</label><strong id="preset-name">${echoPresetShown ? esc(echoPreset.name) : ''}</strong></div>
<div class="row"><label>协议</label><span class="mono" id="preset-api" style="color:var(--muted)">${echoPresetShown ? `${esc(echoPreset.api)}（目录默认）` : ''}</span></div>
<div class="row"><label>API 地址</label><span class="mono" id="preset-url" style="color:var(--muted)">${echoPresetShown ? esc(echoPreset.baseUrl) : ''}</span></div>
<div class="row"><label>获取 key</label><a id="preset-keyurl" target="_blank" rel="noopener" href="${echoPresetShown && echoPreset.keyUrl ? esc(echoPreset.keyUrl) : '#'}"${(echoPresetShown && echoPreset.keyUrl) ? '' : ' hidden'}>官网控制台 ↗</a></div>
</div>
<div id="custom-panel"${echoCustomShown ? '' : ' hidden'}>
<div class="row"><label for="providerId">provider 标识</label><input id="providerId" name="providerId" value="${value('providerId')}" placeholder="如 my-gw（小写字母/数字/连字符）" maxlength="32"></div>
<div class="row"><label for="displayName">显示名（可选）</label><input id="displayName" name="displayName" value="${value('displayName')}" placeholder="留空使用 provider 标识" maxlength="200"></div>
<div class="row"><label for="api">api 协议</label><select id="api" name="api">${apiOptions}</select></div>
<div class="row"><label for="baseURL">API 地址</label><input id="baseURL" name="baseURL" value="${value('baseURL')}" placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" maxlength="200"></div>
<div class="row"><label for="models">模型 ID</label><textarea id="models" name="models" rows="2" placeholder="多个用逗号或换行分隔，如 gpt-4o, deepseek-chat">${value('models')}</textarea></div>
</div>
<div class="row"><label for="apiKey">API key</label><input id="apiKey" name="apiKey" type="password" autocomplete="new-password" placeholder="粘贴模型公司官网签发的 API key（保存后只显示「已配置」，不再显示内容）"></div>
<div class="row"><label></label><label style="color:var(--muted);font-size:12.5px;white-space:nowrap"><input type="checkbox" name="setDefault" id="set-default" value="true"${checked}> 同时设为默认模型</label> <select id="default-model" name="defaultModel" hidden><option value="">选择模型</option></select></div>
<div class="row"><label></label><button class="btn primary" type="submit" id="add-submit">保存</button></div>
</form>
<script>
(function () {
  'use strict'
  var PRESETS = ${JSON.stringify(presetsJson).replace(/</g, '\\u003c')}
  var form = document.getElementById('add-form')
  var hint = document.getElementById('add-hint')
  var kindEl = document.getElementById('add-kind')
  var presetIdEl = document.getElementById('add-presetId')
  var presetPanel = document.getElementById('preset-panel')
  var customPanel = document.getElementById('custom-panel')
  var modelsEl = document.getElementById('models')
  var defaultSel = document.getElementById('default-model')
  var setDefaultChk = document.getElementById('set-default')

  function attr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  }
  function fillOptions(sel, models) {
    sel.innerHTML = '<option value="">选择模型</option>' + models.map(function (m) {
      var id = String(typeof m === 'string' ? m : m.id)
      var name = (typeof m === 'object' && m !== null && m.name) ? String(m.name) : id
      return '<option value="' + attr(id) + '">' + attr(name) + '</option>'
    }).join('')
  }
  function parseModelsText(raw) {
    return String(raw || '').split(/[\s,;，；]+/).map(function (s) { return s.trim() }).filter(Boolean)
  }
  function fillFromCustom() {
    fillOptions(defaultSel, parseModelsText(modelsEl.value).map(function (id) { return { id: id, name: id } }))
  }
  function loadCatalogModels(routeId, sel) {
    sel.innerHTML = '<option value="">加载中…</option>'
    sel.disabled = true
    fetch('/dsh-login/models/models-of?id=' + encodeURIComponent(routeId))
      .then(function (r) { return r.json() })
      .then(function (data) {
        if (data.ok && Array.isArray(data.models) && data.models.length > 0) {
          fillOptions(sel, data.models)
          sel.disabled = false
        } else {
          sel.innerHTML = '<option value="">该 provider 的模型列表暂不可用' + (data.error ? '：' + attr(data.error) : '') + '</option>'
        }
      })
      .catch(function () {
        sel.innerHTML = '<option value="">该 provider 的模型列表暂不可用</option>'
      })
  }
  function showDefaultSel(show) {
    defaultSel.hidden = !show
  }
  function activate(btn) {
    var buttons = document.querySelectorAll('button.preset')
    for (var i = 0; i < buttons.length; i++) buttons[i].classList.remove('primary')
    btn.classList.add('primary')
    hint.style.display = 'none'
    form.hidden = false
    var id = btn.getAttribute('data-preset')
    if (id === '__custom__') {
      kindEl.value = 'custom'
      presetIdEl.value = ''
      presetPanel.style.display = 'none'
      customPanel.hidden = false
      fillFromCustom()
    } else {
      kindEl.value = 'preset'
      presetIdEl.value = id
      var p = PRESETS[id]
      if (p === undefined) return
      presetPanel.style.display = ''
      customPanel.hidden = true
      document.getElementById('preset-name').textContent = p.name
      document.getElementById('preset-api').textContent = p.api + '（目录默认）'
      document.getElementById('preset-url').textContent = p.baseUrl
      var link = document.getElementById('preset-keyurl')
      if (p.keyUrl) { link.hidden = false; link.href = p.keyUrl } else { link.hidden = true }
      loadCatalogModels(id, defaultSel)
    }
  }
  var presetButtons = document.querySelectorAll('button.preset')
  for (var i = 0; i < presetButtons.length; i++) presetButtons[i].addEventListener('click', function () { activate(this) })
  modelsEl.addEventListener('input', function () { if (kindEl.value === 'custom') fillFromCustom() })
  setDefaultChk.addEventListener('change', function () { showDefaultSel(setDefaultChk.checked) })
  if (setDefaultChk.checked) showDefaultSel(true)
  form.addEventListener('submit', function (ev) {
    if (setDefaultChk.checked && !defaultSel.value) {
      ev.preventDefault()
      window.alert('已勾选设为默认模型：请先在右侧下拉框选择一个模型，或取消勾选。')
      return
    }
    if (kindEl.value === 'preset' && document.getElementById('apiKey').value.trim() === '') {
      ev.preventDefault()
      window.alert('内置提供方必须填写 API key（到它的官网控制台获取，见上方链接）。')
    }
  })
  if (!form.hidden) {
    if (kindEl.value === 'preset' && presetIdEl.value) loadCatalogModels(presetIdEl.value, defaultSel)
    else if (kindEl.value === 'custom') fillFromCustom()
  }
  var delButtons = document.querySelectorAll('button[data-del]')
  for (var d = 0; d < delButtons.length; d++) delButtons[d].addEventListener('click', function () {
    var self = this
    var id = self.getAttribute('data-del')
    if (!window.confirm('确认删除 provider "' + id + '"？\\n其配置与存储的 API key 都会被移除，此操作不可恢复。')) return
    self.disabled = true
    fetch('/dsh-login/models/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: id }),
    }).then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data } }) })
      .then(function (out) {
        if (out.status === 200 && out.data.ok) { window.location.reload(); return }
        window.alert('删除失败：' + (out.data.error || ('HTTP ' + String(out.status))))
        self.disabled = false
      })
      .catch(function (e) {
        window.alert('删除失败：' + String(e))
        self.disabled = false
      })
  })
  var dfButtons = document.querySelectorAll('button[data-df]')
  for (var f = 0; f < dfButtons.length; f++) dfButtons[f].addEventListener('click', function () {
    var self = this
    var id = self.getAttribute('data-df')
    var slot = document.querySelector('.df-slot[data-provider="' + id + '"]')
    var sel = slot ? slot.querySelector('select.df-model') : null
    function proceed() {
      if (!sel || !sel.value) { window.alert('请先选择要设为默认的模型'); return }
      self.disabled = true
      fetch('/dsh-login/models/default', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: id, model: sel.value }),
      }).then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data } }) })
        .then(function (out) {
          if (out.status === 200 && out.data.ok) { window.location.reload(); return }
          window.alert('设置默认失败：' + (out.data.error || ('HTTP ' + String(out.status))))
          self.disabled = false
        })
        .catch(function (e) {
          window.alert('设置默认失败：' + String(e))
          self.disabled = false
        })
    }
    if (!sel) { window.alert('模型列表不可用'); return }
    if (sel.hasAttribute('data-loaded')) { proceed(); return }
    sel.innerHTML = '<option value="">加载中…</option>'
    sel.disabled = true
    fetch('/dsh-login/models/models-of?id=' + encodeURIComponent(id))
      .then(function (r) { return r.json() })
      .then(function (data) {
        if (!(data.ok && Array.isArray(data.models) && data.models.length > 0)) {
          sel.innerHTML = ''
          sel.disabled = false
          window.alert('模型列表加载失败：' + (data.error || '未知错误'))
          return
        }
        fillOptions(sel, data.models)
        sel.disabled = false
        sel.setAttribute('data-loaded', '1')
        proceed()
      })
      .catch(function (e) {
        sel.innerHTML = ''
        sel.disabled = false
        window.alert('模型列表加载失败：' + String(e))
      })
  })
})()
</script>
`
  const note = `本页只写你自己环境（独立实例${port > 0 ? `，端口 ${String(port)}` : ''}）的 settings.yaml 与 .credentials.yaml，不影响 hub 或其他用户；保存后 GUI 的模型列表立即生效。`
    + 'API key 只用于访问你选择的服务商：保存后不再显示其内容，「删除」会同时移除该 provider 存储的 key。'
    + '内置提供方的地址 / 协议 / 模型来自 DeepSeek Harness 内置目录，无需填写；目录外的公司请选「自定义」。'
  return shell('我的模型', 'dsh-login · 选择模型公司，粘贴它的 API key 即可使用', body, note)
}
