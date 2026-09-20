/**
 * dsh-login — the login/register page.
 *
 * A single self-contained HTML document (no external assets, no framework):
 * it is served by the gate before the user holds any session, so it must not
 * depend on the app bundle. The page talks to the gate's own endpoints
 * (POST /dsh-login/login, /dsh-login/register, GET /dsh-login/state) with
 * fetch + JSON; a no-JS fallback keeps the plain forms working.
 */

const LOGO_SVG = `<svg width="40" height="40" viewBox="0 0 48 48" fill="none" aria-hidden="true">
  <defs>
    <linearGradient id="dshlg" x1="6" y1="4" x2="42" y2="44" gradientUnits="userSpaceOnUse">
      <stop stop-color="#6d8bff"/>
      <stop offset="1" stop-color="#3350d8"/>
    </linearGradient>
  </defs>
  <rect x="3" y="3" width="42" height="42" rx="12" fill="url(#dshlg)" opacity="0.16"/>
  <rect x="3.75" y="3.75" width="40.5" height="40.5" rx="11.25" stroke="url(#dshlg)" stroke-opacity="0.55" stroke-width="1.5"/>
  <path d="M24 12 L34 24 L24 36 L14 24 Z" stroke="url(#dshlg)" stroke-width="2.4" fill="none" stroke-linejoin="round"/>
  <circle cx="24" cy="24" r="3.2" fill="#6d8bff"/>
</svg>`

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function escapeJs(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('</', '<\\/')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ')
}

/**
 * Render the login/register page.
 * @param options - { error: message to surface, mode: 'login'|'register',
 *   next: validated return path, registerOpen: whether the register tab shows }
 */
export function loginPage({ error = '', notice = '', mode = 'login', next = '/', registerOpen = true } = {}) {
  const err = error ? `<div class="alert" role="alert" id="server-error">${escapeHtml(error)}</div>` : ''
  const noticeHtml = notice ? `<div class="alert ok" role="status" id="server-notice">${escapeHtml(notice)}</div>` : ''
  const nextAttr = escapeHtml(next)
  const initialMode = mode === 'register' && registerOpen ? 'register' : 'login'
  const registerTabs = registerOpen
    ? `<button type="button" class="tab" data-tab="register">注册</button>`
    : ''
  const registerForm = registerOpen
    ? `
  <form id="form-register" class="pane" ${initialMode === 'register' ? '' : 'hidden'} method="post" action="/dsh-login/register" novalidate>
    <h2>创建账号</h2>
    <p class="sub">注册后账号将写入数据库 <code>dsh-login</code> 表</p>
    ${inputRow('reg-username', 'username', '用户名', '3-32 位，支持中英文、数字、_ . -', true, initialMode === 'register')}
    ${passwordRow('reg-password', '设置密码', 8)}
    ${passwordRow('reg-password2', '确认密码', 8)}
    <button class="primary" type="submit" id="btn-register">创建账号并登录</button>
    <input type="hidden" name="next" value="${nextAttr}" />
  </form>`
    : ''

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>登录 · STP Harness</title>
  <style>
    :root{
      --bg:#0a0c11; --card:#11141c; --card2:#0d1017;
      --line:#232936; --line-strong:#303949;
      --text:#e8ebf2; --muted:#8b94a7; --faint:#5b6478;
      --accent:#5b7cfa; --accent-strong:#4463ef;
      --ok:#3ecf8e; --err-bg:#2a1518; --err-line:#5c2b30; --err-text:#ff9d94;
      --warn-bg:#2a2213; --warn-line:#57431d; --warn-text:#ffd97a;
    }
    *{box-sizing:border-box}
    html,body{margin:0;padding:0}
    body{
      min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center;
      background:var(--bg); color:var(--text);
      font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
      padding:24px 16px; position:relative; overflow-x:hidden;
    }
    body::before{
      content:""; position:fixed; inset:-40% -20% auto -20%; height:70vh; pointer-events:none;
      background:radial-gradient(60% 55% at 50% 35%, rgba(91,124,250,.20), transparent 70%);
      filter:blur(10px);
    }
    .card{
      position:relative; width:min(430px,100%);
      background:linear-gradient(180deg,var(--card),var(--card2));
      border:1px solid var(--line); border-radius:18px;
      padding:30px 28px 22px;
      box-shadow:0 24px 70px rgba(0,0,0,.5), 0 2px 8px rgba(0,0,0,.35);
    }
    .brand{display:flex; align-items:center; gap:12px; margin-bottom:22px}
    .brand .mark{flex:0 0 auto; display:flex}
    .brand .name{font-size:16px; font-weight:650; letter-spacing:.2px}
    .brand .name small{display:block; font-size:11px; font-weight:400; color:var(--faint); letter-spacing:.6px; margin-top:1px}
    .state-bar{
      display:none; align-items:center; justify-content:space-between; gap:10px;
      background:rgba(91,124,250,.08); border:1px solid rgba(91,124,250,.30); border-radius:10px;
      padding:8px 12px; margin-bottom:16px; font-size:13px; color:#c3cdf8;
    }
    .state-bar.show{display:flex}
    .state-bar a{color:#aab8ff; text-decoration:none; font-weight:600}
    .state-bar a:hover{text-decoration:underline}
    .tabs{
      display:flex; gap:4px; background:var(--card2); border:1px solid var(--line);
      border-radius:11px; padding:4px; margin-bottom:20px;
    }
    .tab{
      flex:1; border:0; border-radius:8px; background:transparent; color:var(--muted);
      font-size:14px; font-weight:600; padding:8px 0; cursor:pointer; transition:all .15s ease;
    }
    .tab:hover{color:var(--text)}
    .tab.active{background:#1a2030; color:var(--text); box-shadow:inset 0 0 0 1px var(--line-strong)}
    h2{margin:0 0 4px; font-size:17px; font-weight:650}
    .sub{margin:0 0 18px; font-size:12.5px; color:var(--faint)}
    .sub code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; color:var(--muted); background:var(--card2); border:1px solid var(--line); border-radius:5px; padding:1px 5px}
    .field{margin-bottom:14px}
    .field label{display:block; font-size:13px; color:var(--muted); margin-bottom:6px}
    .control{position:relative}
    .control input{
      width:100%; height:46px; border:1px solid var(--line-strong); border-radius:10px;
      background:var(--card2); color:var(--text); font-size:14.5px;
      padding:0 42px 0 14px; outline:none; transition:border-color .15s ease, box-shadow .15s ease;
    }
    .control input::placeholder{color:var(--faint)}
    .control input:focus{border-color:var(--accent); box-shadow:0 0 0 3px rgba(91,124,250,.18)}
    .eye{
      position:absolute; right:6px; top:50%; transform:translateY(-50%);
      width:32px; height:32px; border:0; border-radius:8px; background:transparent;
      color:var(--faint); cursor:pointer; display:flex; align-items:center; justify-content:center;
    }
    .eye:hover{color:var(--muted); background:rgba(255,255,255,.04)}
    .hint{font-size:11.5px; color:var(--faint); margin-top:5px; min-height:0}
    .alert{
      border-radius:10px; padding:9px 12px; font-size:13px; margin-bottom:14px; line-height:1.45;
    }
    .alert.error{background:var(--err-bg); border:1px solid var(--err-line); color:var(--err-text)}
    .alert.warn{background:var(--warn-bg); border:1px solid var(--warn-line); color:var(--warn-text)}
    .alert.ok{background:rgba(62,207,142,.10); border:1px solid rgba(62,207,142,.35); color:var(--ok)}
    .alert a{color:inherit; text-decoration:underline; word-break:break-all}
    .primary{
      width:100%; height:47px; margin-top:4px; border:0; border-radius:11px; cursor:pointer;
      background:linear-gradient(135deg,var(--accent) 0%,var(--accent-strong) 100%);
      color:#fff; font-size:15px; font-weight:650; letter-spacing:.3px;
      display:flex; align-items:center; justify-content:center; gap:8px;
      transition:filter .15s ease, transform .05s ease;
    }
    .primary:hover{filter:brightness(1.08)}
    .primary:active{transform:translateY(1px)}
    .primary:disabled{filter:grayscale(.4) brightness(.8); cursor:wait}
    .spinner{
      width:15px; height:15px; border-radius:50%; display:none;
      border:2px solid rgba(255,255,255,.35); border-top-color:#fff; animation:spin .7s linear infinite;
    }
    .primary.loading .spinner{display:inline-block}
    @keyframes spin{to{transform:rotate(360deg)}}
    .foot{margin-top:20px; text-align:center; font-size:11.5px; color:var(--faint); line-height:1.7}
    .foot .dot{margin:0 6px; opacity:.6}
    @media (max-width:480px){
      .card{padding:24px 20px 18px; border-radius:16px}
    }
  </style>
</head>
<body>
  <main class="card" aria-busy="false">
    <div class="brand">
      <span class="mark">${LOGO_SVG}</span>
      <div class="name">STP Harness<small>Web GUI · 统一登录</small></div>
    </div>

    <div class="state-bar" id="state-bar">
      <span id="state-text"></span>
      <span><a href="/" id="state-enter">进入应用</a> &nbsp;·&nbsp; <a href="/dsh-login/logout" id="state-logout">退出登录</a></span>
    </div>

    <div class="alert warn" id="db-warn" hidden>数据库暂不可用，登录与注册会失败。请稍后重试。</div>
    ${noticeHtml}
    ${err}

    <div class="tabs" role="tablist" id="tabs">
      <button type="button" class="tab${initialMode === 'login' ? ' active' : ''}" data-tab="login" role="tab">登录</button>
      ${registerTabs}
    </div>

    <form id="form-login" class="pane" ${initialMode === 'login' ? '' : 'hidden'} method="post" action="/dsh-login/login" novalidate>
      <h2>登录</h2>
      <p class="sub">使用已注册的账号登录 STP</p>
      ${inputRow('login-username', 'username', '用户名', '', false, initialMode === 'login')}
      ${passwordRow('login-password', '密码', 8)}
      <button class="primary" type="submit" id="btn-login">
        <span class="spinner" aria-hidden="true"></span><span class="label">登 录</span>
      </button>
      <input type="hidden" name="next" value="${nextAttr}" />
    </form>
    ${registerForm}
  </main>

  <footer class="foot">
    STP Harness<span class="dot">·</span>账号存于数据库 <code style="font-family:ui-monospace,monospace">dsh-login</code> 表
  </footer>

  <script>
  (() => {
    const NEXT = '${escapeJs(next)}';
    const REGISTER_OPEN = ${registerOpen ? 'true' : 'false'};
    const $ = (id) => document.getElementById(id);
    const tabs = $('tabs');

    function showAlert(kind, text) {
      document.querySelectorAll('.alert.error, .alert.ok').forEach((n) => n.remove());
      if (!text) return;
      const box = document.createElement('div');
      box.className = 'alert ' + kind;
      box.setAttribute('role', 'alert');
      box.textContent = text;
      const bar = $('state-bar');
      bar ? box.insertAdjacentElement('afterend', box) : document.querySelector('.card').prepend(box);
    }
    function setBusy(btn, busy) {
      btn.classList.toggle('loading', busy);
      btn.disabled = busy;
    }
    // A small branded "opening" screen for the pre-opened window.
    const OPENING_HTML =
      '<!doctype html><html><head><meta charset="utf-8"><title>正在打开…</title>' +
      '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
      'background:#0b0e14;color:#9aa4b8;font:14px system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}' +
      '.w{display:flex;align-items:center;gap:10px}' +
      '.s{width:16px;height:16px;border:2px solid rgba(255,255,255,.18);border-top-color:#5b8cff;' +
      'border-radius:50%;animation:sp .7s linear infinite}' +
      '@keyframes sp{to{transform:rotate(360deg)}}</style></head>' +
      '<body><div class="w"><span class="s"></span>正在打开…</div></body></html>';
    // Pre-open a window DURING the user gesture and hand back a handle. The
    // cross-port handoff target is navigated there after the (possibly slow,
    // 30s~2min provisioning) fetch: a window.open() called after that await
    // would be rejected by the popup blocker.
    function openPlaceholder() {
      let pop = null;
      try { pop = window.open('', '_blank'); } catch (e) { pop = null; }
      if (pop) {
        try { pop.document.open(); pop.document.write(OPENING_HTML); pop.document.close(); } catch (e) {}
      }
      return pop;
    }
    async function post(form, btn, url) {
      const data = Object.fromEntries(new FormData(form).entries());
      setBusy(btn, true);
      const label = btn.querySelector('.label');
      const origLabel = label ? label.textContent : btn.textContent;
      const pop = openPlaceholder();
      const closePop = () => { try { if (pop) pop.close(); } catch (e) {} };
      // A regular user's first login blocks on server-side provisioning
      // (30s~2min). Say so after 8s so a slow answer is not silent.
      const waitHint = setTimeout(() => {
        if (label) label.textContent = '正在创建独立环境（约需 30 秒~2 分钟），请勿关闭页面…';
        else btn.textContent = '正在创建独立环境（约需 30 秒~2 分钟），请勿关闭页面…';
      }, 8000);
      try {
        // The hub answers this JSON protocol with { ok: true, target }: a JS
        // caller cannot read the Location of a redirect (a manual-redirect
        // response is opaque — status 0, unreadable headers), so the target
        // has to be delivered explicitly.
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-login-json': '1' },
          body: JSON.stringify(data),
        });
        let body = null;
        try { body = await res.json(); } catch (e) { /* non-JSON response */ }
        if (res.status === 200 && body !== null && body.ok === true && body.pending === true) {
          // Registration succeeded, but the account waits for an administrator:
          // no session was issued, so stay on the page and say so.
          closePop();
          showAlert('ok', typeof body.message === 'string' ? body.message : '注册成功，请等待管理员审批');
          activate('login');
          return;
        }
        if (res.status === 200 && body !== null && body.ok === true && typeof body.target === 'string') {
          const loc = body.target;
          let target = null;
          try { target = new URL(loc, window.location.href); } catch (e) {}
          const crossOrigin = target !== null &&
            (target.hostname !== window.location.hostname || target.port !== window.location.port);
          if (crossOrigin) {
            // A regular user lands on their own instance on another port:
            // send the pre-opened window there (a NEW WINDOW), keeping this
            // tab on the hub so the account can be switched back.
            if (pop) {
              try { pop.location.href = loc; }
              catch (e) { closePop(); window.location.replace(loc); return; }
              showAlert('ok', '已在新窗口打开独立环境。当前页面保留；需要时用「退出登录」切换账号。');
              return;
            }
            window.location.replace(loc); // placeholder blocked: same tab
            return;
          }
          closePop();
          window.location.replace(loc || (NEXT || '/'));
          return;
        }
        closePop();
        const msg = body !== null && typeof body.error === 'string'
          ? body.error
          : '请求失败（' + res.status + '）';
        showAlert('error', msg);
      } catch (e) {
        closePop();
        showAlert('error', '网络错误，请确认连接后重试。');
      } finally {
        clearTimeout(waitHint);
        if (label) label.textContent = origLabel;
        else if (btn.textContent !== origLabel) btn.textContent = origLabel;
        setBusy(btn, false);
      }
    }
    // Tab switching
    function activate(name) {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
      $('form-login').hidden = name !== 'login';
      const reg = $('form-register');
      if (reg) reg.hidden = name !== 'register';
      const first = name === 'login' ? $('login-username') : $('reg-username');
      if (first && window.matchMedia('(max-width:480px)').matches) { try { first.focus() } catch (e) {} }
    }
    tabs.addEventListener('click', (ev) => {
      const t = ev.target.closest('.tab');
      if (t) activate(t.dataset.tab);
    });
    // Password visibility toggles
    document.querySelectorAll('.eye').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.target);
        if (!input) return;
        input.type = input.type === 'password' ? 'text' : 'password';
        btn.setAttribute('aria-label', input.type === 'password' ? '显示密码' : '隐藏密码');
      });
    });
    // Submit handlers (JSON fetch; the plain form fallback still works without JS)
    const fl = $('form-login');
    if (fl) fl.addEventListener('submit', (ev) => { ev.preventDefault(); post(fl, $('btn-login'), '/dsh-login/login'); });
    const fr = $('form-register');
    if (fr) fr.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const p1 = $('reg-password').value;
      const p2 = $('reg-password2').value;
      if (p1 !== p2) { showAlert('error', '两次输入的密码不一致。'); return; }
      post(fr, $('btn-register'), '/dsh-login/register');
    });
    // Session + database state on load
    (async () => {
      try {
        const res = await fetch('/dsh-login/state', { cache: 'no-store' });
        if (!res.ok) return;
        const st = await res.json();
        if (st.authenticated) {
          const bar = $('state-bar');
          $('state-text').textContent = '已登录：' + (st.username || '') + '（当前会话有效）';
          bar.classList.add('show');
          $('state-enter').href = NEXT || '/';
        }
        if (st.db !== 'up') $('db-warn').hidden = false;
      } catch (e) { /* state endpoint unavailable; page still works */ }
    })();
  })();
  </script>
</body>
</html>
`;
}

function inputRow(id, name, label, hint, autofocus, focus) {
  const attr = focus ? ' autofocus' : ''
  const hintHtml = hint ? `<div class="hint">${escapeHtml(hint)}</div>` : ''
  return `
  <div class="field">
    <label for="${id}">${escapeHtml(label)}</label>
    <div class="control">
      <input id="${id}" name="${name}" type="text" autocomplete="username" maxlength="64" required minlength="2"${attr} />
    </div>
    ${hintHtml}
  </div>`
}

function passwordRow(id, label, minlength) {
  return `
  <div class="field">
    <label for="${id}">${escapeHtml(label)}</label>
    <div class="control">
      <input id="${id}" name="${id.endsWith('2') ? 'password2' : 'password'}" type="password" autocomplete="current-password" maxlength="128" required minlength="${minlength}" />
      <button type="button" class="eye" data-target="${id}" aria-label="显示密码" tabindex="-1">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      </button>
    </div>
  </div>`
}
