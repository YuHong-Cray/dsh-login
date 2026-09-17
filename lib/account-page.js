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
 */

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
    + 'DSH 明确规定非 loopback 页面不得编辑 host 设置，所以 LAN 下用户无法使用原生「设置 → 模型」页，这里由管理员代为写入同一套受校验的写入接口。'
  return shell(`配置 ${esc(user)} 的模型`, 'dsh-login · 管理员操作', body, note)
}
