# dsh-login

为 DeepSeek Harness Web GUI 提供**基于数据库的多用户登录门禁 + 每用户独立工作区**：

- **hub**（操作员的 `dsh web`，本部署为 3080 端口）是唯一登录面：登录页支持**注册**与**登录**，注册把新账号写入 MySQL 账号表（本部署为 `dsh` 库的 `dsh_login` 表），登录先用数据库认证，**认证通过才能使用应用**；
- **管理员**（配置 `adminUsers`）登录后直接进入 hub 应用（3080），行为与单用户门禁时代完全一致；
- **普通用户**登录/注册成功后，hub 自动为其供给一个**独立的 dsh web 实例**：独立 `DSH_HOME`（`/srv/dsh-users/<username>/`）、独立端口（3100 起）、独立会话/设置/工作区，并运行在该用户**专属的非特权 OS 账号**下（见「多租户隔离」）——每个用户的工作区彼此隔离、互不影响。

本插件是 `dsh web` 宿主侧插件（纯 Node.js，无构建步骤），以 bundle 形式挂入 web profile，替换了原 `dsh-lan-gate` 的固定密码门禁。同一份代码以两种模式运行（由 `$DSH_HOME/dsh-login.json` 决定）：

| 模式 | 运行位置 | 职责 |
| --- | --- | --- |
| `hub`（默认） | 操作员的 dsh web | 登录/注册（MySQL）、管理员直放、普通用户 handoff、用户实例生命周期管理 |
| `instance` | 每个用户实例 | 兑换 handoff、内置会话门禁、回跳 hub 登录页（无数据库依赖） |

## 架构

```
浏览器 ──3080──► hub: dsh web + dsh-login(hub 模式)
                   ├─ 登录页 / 注册（MySQL dsh_login，scrypt 校验）
                   ├─ 管理员 → hub 应用（3080，原有工作区/会话）
                   └─ 普通用户 → 确保其实例就绪 → 铸造 handoff → 302
                                    │
                                    │ 302 http://<host>:<userPort>/<next>?handoff=<v1 签名令牌>
                                    ▼
            用户实例: 独立 dsh web 进程（detached，独立进程组）
                   DSH_HOME = /srv/dsh-users/<username>/
                   dsh-login(instance 模式) 门禁：
                   ├─ handoff 有效且未兑换 → 铸造 30 天内置 cookie → 303 到去掉 handoff 的 URL
                   ├─ 有效内置 cookie → 放行给 DSH 内置 BrowserAuth（同密钥双重校验）
                   └─ 无 cookie → 302 回 hub 登录页（next=当前实例绝对 URL）/ /api、WS → 401
                   独立 sessions/ · settings.yaml · 工作区（默认目录=用户目录）
```

关键机制：

- **handoff 令牌**与 DSH 内置会话 cookie 同一 `v1.<body>.<hmac>` 签名格式，签名密钥是 `.credentials.yaml` 里的 browser-session secret。hub 供给用户实例时**只写入这一条记录**（`renderInstanceCredentials`），因此 hub 能用自己已缓存的密钥为该实例铸造合法 handoff，而实例不再继承 hub 的任何 API key；
- **每个用户实例的配置完全独立**：`settings.yaml` 以 `INSTANCE_SETTINGS_TEMPLATE` 起步——不含任何 provider/密钥，并写入 `llm-deepseek: { models: [] }` 以**隐藏 DSH 自带的 `deepseek-official` 目录**（该目录随 `@deepseek-ai/dsh-base` 提供、与管理员配置无关，且没有 `DEEPSEEK_API_KEY` 时不可用）。模型 / provider / API key 由管理员在「用户管理 → 模型」授予，或用户在本实例的「我的模型」里自行添加；**普通用户能否自行添加 / 更改模型参数由管理员在「用户管理」里逐人开关，默认禁止**（见「模型自设审批」一节）；
- handoff **10 分钟有效、一次性**（实例内存记录已兑换令牌的 sha256）；兑换后实例铸造常规 30 天 cookie，handoff 本身弃用；
- HTTP cookie 按 Host 域隔离、**不按端口隔离**，因此 302 跨端口跳转到同一主机即可带票进入用户实例；
- 用户实例绑定 `0.0.0.0`（复用 `dsh-lan-access`），局域网可达；每个实例受自己的门禁保护；
- 用户实例以 **detached** 方式启动：hub 重启（含 Ctrl+C）不连带杀死；hub 重启时从 `instance.json` 重新**收养**；实例进程挂掉时下次登录**懒拉起**。

## 工作流程（hub 模式）

```
浏览器 ──► hub 门禁
  ├─ 网络准入：本机回环放行；局域网必须命中 CIDR 白名单；拒绝代理转发表头
  ├─ /dsh-login/*（登录面）恒可达
  ├─ 管理员会话 → 放行 hub 应用（3080）
  ├─ 普通用户会话 → 仅登录面可用；其余路径 302 到其实例（端口未知时回登录页）
  └─ 无会话 → GET 302 登录页 / /api、WS 401

登录或注册成功：
  ├─ 管理员 → 302 next（默认 /）+ 会话 cookie + 30 天 hub 内置 cookie
  └─ 普通用户 → 确保实例就绪（首次：provisioning，约 30s~2min；其后秒级）
        → 铸造 10 分钟一次性 handoff（绑定 <请求Host去掉端口>:<userPort>）
        → 302 http://<host>:<userPort><next>?handoff=<token>
```

## 工作流程（instance 模式）

```
浏览器 ──► 实例门禁
  ├─ 网络准入（同 hub 规则）
  ├─ /dsh-login/{health,state,logout}（运维/探活接口）
  ├─ 有效内置 cookie → 放行（内置 BrowserAuth 再校验一次，同源同密钥）
  ├─ GET *?handoff=<有效未兑换> → Set-Cookie 30 天内置 cookie → 303 到去掉 handoff 的 URL
  │                              （Referrer-Policy: no-referrer，令牌不进 referrer）
  └─ 无 cookie → GET 302 回 hub 登录页（next=当前实例绝对 URL，登录后原路带回）
                 /api、WS → 401
```

## 文件结构

| 文件 | 说明 |
| --- | --- |
| `index.js` | 插件入口：hub/instance 双模式门禁、`/dsh-login/*` 路由、handoff 铸造与兑换 |
| `lib/config.js` | 部署配置读写（`$DSH_HOME/dsh-login.json`，hub/instance 双模式） |
| `lib/db.js` | MySQL 访问（mysql2 连接池、建表、注册/查询/更新/删除，全部参数化 SQL；仅 hub 模式惰性加载） |
| `lib/auth.js` | scrypt 密码哈希、会话存储、限流、cookie 工具 |
| `lib/inner.js` | 内置会话 cookie / handoff 令牌的铸造与校验（与 BrowserAuth 字节兼容） |
| `lib/instances.js` | 用户实例生命周期：端口分配、provisioning（DSH_HOME/profile/pnpm install）、detached 启动、就绪探测、收养、删除 |
| `lib/account-page.js` | 账户中心 / 用户管理 / 进入确认 / 我的模型 四个服务端渲染页面（深色主题） |
| `lib/model-config.js` | 模型配置校验与写入序列：管理员页与用户自助页共用（provider/模型/key 校验、`settings/mutate` + `credentials/set` 操作序列） |
| `lib/model-policy.js` | 「普通用户能否自行设置模型参数」开关的镜像：hub 把数据库里的决定写进用户 `DSH_HOME/dsh-login-model-policy.json`，用户实例每次请求现读（缺失即禁止） |
| `lib/provider-presets.js` | 内置提供方预设表（18 家，常用 8 家置顶；id/baseURL/默认模型均与 pi-ai 内置目录核对一致） |
| `lib/cidr.js` | IPv4 CIDR / 回环地址判断 |
| `lib/page.js` | 登录页（自包含 HTML/CSS/JS，深色主题，登录/注册双页签） |
| `lib/client.js` | **浏览器半边**：管理员登录后在右侧边栏「开始」页贡献「用户管理」入口，点开即在侧边栏内嵌 `/dsh-login/users`。按 client module system 的 bundle 格式手写（本插件无构建步骤），角色取自 `/dsh-login/state` 的 `admin` 字段 |
| `cordis.patch.yml` | bundle 补丁：向 profile 树插入插件行 |
| `test/gate.test.mjs` | 集成测试（假宿主 + 真实 MySQL + 租户原语） |
| `test/my-models.test.mjs` | 用户自助模型页测试（预设表/校验/写入序列/自设开关镜像与门禁/假宿主集成；**不需要 MySQL**） |
| `test/client-half.test.mjs` | 浏览器半边测试（VM 内执行 bundle + 假 ctx/fetch：管理员注册入口、非管理员不注册；**不需要 MySQL**） |
| `test/inner-real.spec.mjs` | 与运行中 dsh web 的字节兼容性验证（对已部署门禁的宿主自动跳过） |

## 右侧边栏「用户管理」入口（浏览器半边）

`package.json` 的 `dsh.client` 让 Web shell 把 `lib/client.js` 当作同源 classic script 载入。它只在**管理员**登录后向右侧边栏注册一个页面类型「用户管理」：展开右侧边栏的「开始」页会多出一张入口卡片，点开就用 iframe 内嵌 `/dsh-login/users`（同源，页面未设 `X-Frame-Options`）。非管理员启动时 `apply` 读 `/dsh-login/state` 得到 `admin !== true`，于是什么都不注册，右侧边栏看不到该入口。

- 该半边**手写**为 client module system 的 bundle 格式（`window.__ModuleLoader__.load({ id, factory })`），因为本插件没有构建步骤；factory 的 `require` 只用到 shell 预置的 React 基线，其余能力全部经注入的 Cordis 服务（`slots` / `sidebarRightTabs` / `locale`）取得；
- 改动宿主半边或 `package.json` 的 `dsh.client` 之后**必须重启 `dsh web`**：client module registry 会把「这个包不是 client 包」的判定缓存到进程重启，然后浏览器刷新即可看到入口；
- 验证：`node --test test/client-half.test.mjs`（在 VM 里执行真实 bundle，配假 ctx/fetch）。部署侧端到端核对的临时脚本见 `/root/dsh-login-restore/verify-client-half.sh`。

## 账号表

表名由配置 `db.table` 指定（本部署为 `dsh_login`）。表不存在时插件会自动创建；已存在则直接使用（要求至少包含 `username` 与 `password_hash` 两列，`username` 需有唯一索引）。参考 DDL：

```sql
CREATE TABLE IF NOT EXISTS `dsh_login` (
  `id`            BIGINT AUTO_INCREMENT PRIMARY KEY,
  `username`      VARCHAR(64)  NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,          -- scrypt$N$r$p$salt$hash，永不明文
  `status`        VARCHAR(16)  NOT NULL DEFAULT 'approved',  -- approved | pending | rejected
  `model_self_service` TINYINT(1) NOT NULL DEFAULT 0,        -- 1 = 允许自行设置模型参数
  `created_at`    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  `last_login_at` TIMESTAMP    NULL
);
```

> 升级：`ensureTable()` 会为老表自动补齐 `status`（默认 `'approved'`）与 `model_self_service`（默认 `0`）两列。

## 部署配置

### hub 模式（操作员的 `$DSH_HOME/dsh-login.json`，0600）

```json
{
  "db": {
    "host": "192.168.0.100",
    "port": 3306,
    "user": "dsh_user",
    "password": "********",
    "database": "dsh",
    "table": "dsh_login"
  },
  "allowCidrs": ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
  "rejectProxyHeaders": true,
  "sessionTtlSec": 604800,
  "register": "open",
  "requireApproval": true,
  "adminUsers": ["admin"],
  "instances": {
    "root": "/srv/dsh-users",
    "portBase": 3100,
    "checkout": "/deepseek-harness",
    "hubBase": "http://192.168.0.50:3080/"
  }
}
```

- `adminUsers`：管理员账号列表（2–32 位，字符集同用户名规则）；**留空/省略 = 无管理员**（所有用户都走独立实例）。管理员**不受注册审批约束**。
- `register`：`open` 开放自助注册；`disabled` 关闭注册（登录页只保留登录页签）。
- `requireApproval`：**注册审批开关，默认 `true`**。开启时自助注册的账号以 `pending` 写入数据库、**不自动登录、不分配实例**，必须由管理员在「用户管理」里点「通过」后才能登录；设为 `false` 则恢复"注册即登录"的旧行为。（管理员账号始终直接可用。）

### 注册审批流程

1. 用户在登录页「注册」→ 提交后账号以 `pending` 入库，页面提示「注册成功！请等待管理员审批」，**不签发任何会话、不创建实例**（JSON 路径返回 `{ok:true, pending:true, message}`，无 JS 的表单路径 303 回登录页并显示同样的提示）；
2. 管理员打开「账户中心 → 用户管理」（`/dsh-login/users`）：顶部会提示"有 N 个账号等待审批"，表格新增**状态**列（已通过 / 待审批 / 已拒绝）与「通过 / 拒绝」按钮；
3. 点「通过」后该账号即可登录并进入自己的实例；点「拒绝」则登录被拒（提示"未通过管理员审批"，之后仍可再点「通过」恢复）；
4. 登录时的判定：`status !== 'approved'` 的普通账号一律 403（`pending` 与 `rejected` 给不同文案），管理员豁免。

> 数据库升级：`ensureTable()` 会为老表自动 `ALTER TABLE ... ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'approved'`，因此**升级前已存在的账号全部视为已通过**，不会被锁在门外。

### 模型自设审批（普通用户能否自行设置模型参数）

管理员**逐人**控制普通用户能否在自己的实例里自行添加 / 更改模型参数（provider、baseURL、模型、API key）：

1. 「账户中心 → 用户管理」（`/dsh-login/users`）表格新增**自行设置模型**列与按钮：默认**已禁止**；点「允许自行设置模型」即为**批准**（此后该用户可自由增删改，无需逐次审批），点「禁止自行设置模型」立即收回；
2. 开关同时写两处：账号表 `model_self_service` 列（控制台的事实来源）+ 该用户 `DSH_HOME/dsh-login-model-policy.json`（实例**每次请求现读**，因此改开关**不需要重启实例**，也不依赖 hub 在线）；
3. 未获批准时：该用户的**整个「模型设置」接口被关闭**——`GET /dsh-login/models` 返回 403 的「管理员已关闭」页面（不列出 provider、不渲染表单），`POST /models`、`/models/delete`、`/models/default`、`/models/models-of` 一律 **403**（服务端强制，不只是隐藏按钮），账户中心也不再提供「我的模型」链接。已配置的模型仍可在会话里正常使用，只是不能改动；
4. 管理员始终可以用「用户管理 → 模型」页直接代管某个用户的模型配置；**是否批准用户自助与管理员能否代管互不影响**；
5. **失败关闭（fail closed）**：镜像文件缺失、不可读或内容非法都按「禁止」处理。所以升级后已存在的实例默认仍是禁止，需要管理员显式批准；`ensure()` 时 hub 会按数据库重新写一遍镜像，re-provision 或恢复备份后也会自动回到数据库的决定。


- `sessionTtlSec`：hub 会话有效期（秒），范围 60 ~ 31536000。
- `instances.root`：用户实例 DSH_HOME 根目录（绝对路径，默认 `/srv/dsh-users`）。
- `instances.portBase`：用户实例首个端口（默认 `3100`）。每个用户的端口写入 `<root>/<u>/instance.json` 持久化，**重启后端口稳定不变**（用户书签/已铸造 cookie 继续有效）。
- `instances.checkout`：DSH checkout（用户实例**镜像 hub 自身的启动平面**：hub 跑 `apps/cli/lib/bin.js` 编译产物时实例也跑编译产物，hub 以 tsx 跑 `apps/cli/src/bin.ts` 源码时实例同样跑源码；默认 `/deepseek-harness`）。
- `instances.hubBase`：hub 的规范地址（实例端回跳/退出时用它拼登录页 URL）；**省略时自动派生**为「本机第一个非回环 IPv4 + hub 监听端口」。
- `instances.isolation`：`"uid"`（默认）让每个实例运行在**专属非特权 OS 账号**下，其 DSH_HOME 归该 uid 所有并设 0700；`"none"` 保留旧的 root 单租户模式（仅开发用）。`"uid"` 要求 hub 以 root 运行；实例根目录必须能被租户穿越（见「多租户隔离」）。
- `instances.osUserPrefix`：租户账号名前缀（默认 `dsh-`，须是小写 Linux 账号前缀，≤ 16 字符）。
- `instances.maxOldSpaceMb`：每个实例的 V8 堆上限（默认 `1536`，`0` = 不限）。
- `instances.nprocLimit`：每个租户的进程数上限（默认 `512`，经 `prlimit --nproc`；`0` = 不限）。

### instance 模式（hub 在 provisioning 时自动写入每个用户 `DSH_HOME/dsh-login.json`，通常无需手工编辑）

```json
{
  "instance": true,
  "hubBase": "http://192.168.0.50:3080/",
  "handoffTtlSec": 600,
  "allowCidrs": ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
  "rejectProxyHeaders": true
}
```

## 用户实例 provisioning 细节

用户**首次**登录/注册时自动执行（约 30s~2min，取决于 pnpm store 冷热）：

```
/srv/dsh-users/<username>/
  .credentials.yaml   ← 仅含 hub 的 browser-session 签名密钥（handoff 必需）0600
  settings.yaml       ← 模板：无 provider/密钥 + 隐藏内置 deepseek-official 目录
  dsh-login.json      ← 实例模式配置（hub 写入） 0600
  instance.json       ← { port, pid, startedAt, provisionedAt }
  web.log             ← 实例 stdout/stderr（排障看这里）
  profiles/web/       ← 实例 profile：dsh-base + dsh-web-app + dsh-lan-access + dsh-login(file: 拷贝)
  sessions/ storages/ ← 运行期自动创建
```

实例启动命令（由 hub 以 detached 方式发出，独立进程组）**镜像 hub 自己的启动向量**（`lib/instances.js` 的 `instanceLaunchVector()`，取 `process.argv[1]`）：

```
# hub 运行编译产物（apps/cli/lib/bin.js）时：
node <checkout>/apps/cli/lib/bin.js web --no-open --port <P>

# hub 以 tsx 运行源码（apps/cli/src/bin.ts）时：
node --import <checkout>/node_modules/tsx/dist/esm/index.mjs \
      <checkout>/apps/cli/src/bin.ts web --no-open --port <P>
  env TSX_TSCONFIG_PATH = <checkout>/tsconfig.json

  cwd = /srv/dsh-users/<username>      # 新会话默认工作目录 = 用户目录（隔离关键）
  env DSH_HOME = /srv/dsh-users/<username>
```

- `cwd` 即会话控制器的 `defaultCwd`：用户新建的会话默认落在**自己的目录**，不会写到 DSH 源码树或其他用户目录；
- **实例必须与 hub 处于同一模块平面（重要，2026-09-20 修复）**：tsx 的 tsconfig `paths` 映射会把嵌套的 `@deepseek-ai/*` 导入指向 `src` 源码，而 profile 的包解析把 loader 入口加载为安装目录里的编译产物 `lib`。两者混用会加载**两份 `@deepseek-ai/dsh-tools`**：注册 `tools` 服务的那份来自 `lib/index.js`，agent loop 读取的模块私有符号 `TOOL_RUNTIME_SCHEDULER` 来自 `src/index.ts`，于是 `ctx.tools[TOOL_RUNTIME_SCHEDULER]` 为 `undefined`，**每一次工具调用都让该轮以 `Cannot read properties of undefined (reading 'prepare')`（stop code `UNKNOWN`）失败**——症状就是普通用户会话里工具调用卡片出现后立刻「本轮运行失败」。hub 跑编译产物时实例也必须跑编译产物（此前硬编码 tsx+src，正是崩溃的来源）；
- `TSX_TSCONFIG_PATH` 只在源码向量下注入：tsx 按「工作目录向上找 tsconfig」解析 workspace 路径映射（把 `@deepseek-ai/*` 指向源码）；缺失时会加载 checkout 里已编译的 vendor 库而启动失败（症状：`web.log` 中 `does not provide an export named ...`）。

就绪判据：实例的 `/dsh-login/health` 返回 200（120s 超时，超时则该次登录返回 503，重试即可——provisioning 幂等）。health 同时返回 `identity`（其 `DSH_HOME` 的 sha256 前 16 位），hub 用它确认「这个端口上跑的确实是我为当前目录供给的实例」。

### 多租户隔离（UID 降权，2026-09-20）

`instances.isolation: "uid"` 时，provisioning 会在首次启动前、`ensure()` 在每次启动前确保：

1. 派生并创建租户账号 `osUserFor(username)`：`useradd --system --no-create-home --shell /usr/sbin/nologin`，幂等；账号名是 `<prefix><可读前缀>-<sha256 前 6 位>`（ASCII、≤32 字符，中文用户名也能安全映射）；「用户管理 → 删除」会 `userdel`。
2. 实例根目录可被穿越：`instances.root` 本身补 `o+x`（0711，能到达自己目录、不能列邻居）；**上层目录若是 0700（如 `/root`），直接抛错让该次登录 503 并说明要搬家**，绝不静默放开 `/root`。
3. profile 固定 `packageImportMethod: copy`（写 `profiles/web/pnpm-workspace.yaml`，同时写 `.npmrc` 兼容旧版 pnpm）：pnpm 默认硬链接会把 store 的 inode 链进 `node_modules`，对它 `chown -R` 会连带改掉 store 内容的属主——而 hub 自己的 profile 也共享同一批 inode，实测会让租户“拥有” hub 的 `dsh-lan-access` 文件。chown 之前还会扫描 home，把任何 `nlink > 1` 的文件重写成私有副本（`breakSharedHardlinks()`），作为最后一道保险（pnpm 12 会忽略 `.npmrc` 里的该键，只有 `pnpm-workspace.yaml` 生效）。
4. `chown -R -h -P <uid>:<gid> <home>`（`-h` 确保 profile 里指向 checkout 的符号链接不被解引用），并把 home 设 0700。
5. 启动时 `spawn(..., { uid, gid })` 降权；`HOME`/`USER`/`LOGNAME` 指向租户自己（旧实现会继承 hub 的 `HOME=/root`），并施加 `--max-old-space-size` 与 `prlimit --nproc` 限额。

**从 root 模式升级**：home 属主仍是 root 时，下一次 `ensure()` 会打印 `migrating <user>'s home to <osUser>`，先停掉 `instance.json` 记录的进程（用 `/proc/<pid>/cmdline` 校验 pid 未被回收才发信号）、按 copy 方式重装 profile 依赖、再 chown。**布局前提**：`/root` 是 0700，租户够不到 `/root/dsh-users/**`，因此实例根目录必须在 `/root` 之外（默认 `/srv/dsh-users`）：把 `instances.root` 改到新路径，并 `mv` 旧目录。

**挡得住**：另一个租户（或该租户自己）在 `danger-full-access` 会话里读 hub 的 `/root/.dsh`（含管理员 `DEEPSEEK_API_KEY` 与 `dsh-login.json` 里的数据库口令）、读写 `/stp-harness` 检出、读写邻居的 home/会话。
**挡不住**：租户对自己的 `settings.yaml`/`.credentials.yaml`/实例 `/api` 仍有完全控制（那是他自己的东西）；网络不做限制（仍可访问内网/数据库端口，但已拿不到 hub 里的数据库口令与管理员 key）；hub 仍是 root，请保持 `instances.root`、checkout、hub home 的属主与权限不变。

**不要手工 `rm -rf /srv/dsh-users/<u>` 删用户目录（重要）**：若其实例仍在运行，旧进程会继续占着端口、却服务一个已被删除的 home。症状是 GUI 里 `本轮运行失败 ENOENT: ... /sessions/<id>/session.v3.jsonl.zstd`（旧目录已删，它内存中的会话指向不存在的文件），而且新实例抢端口会 `EADDRINUSE` 崩溃。请改用「用户管理 → 删除」（`manager.remove()` 先 SIGTERM 再删目录）。

hub 侧另有两道防护（`lib/instances.js`）：`allocatePort()` 分配端口时**跳过真正在监听的端口**（避免 EADDRINUSE，并让该用户自动落到下一个空闲端口）；`probeHealth()` 校验 `identity`，若记录端口上的实例不是本用户当前 home（陈旧僵尸进程）则**自动换端口** spawn，而不是复用它。

**WebSocket 升级必须透传 `head`（维护注意）**：实例门禁为了先做准入判断，包装了 `server.on('upgrade')`，转发给原监听器时**必须带上第三个参数**：

```js
server.on('upgrade', (req, socket, head) => { /* …准入判断… */
  for (const listener of upgrades) listener.call(server, req, socket, head)   // ← head 不可省
})
```

WebSocket 服务端会**先写出 `101` 响应**，随后从 `head` 排空「握手头之后已经缓冲的字节」；若传 `undefined`，这一步会在握手成功**之后**抛错，HTTP 层捕获后立即 `socket.destroy()`。症状极具迷惑性：GUI 页面能正常打开、HTTP `/api` 单发请求全部正常，但长连接（`$events` 事件流）一连上就断，界面永久停在左下角「重新连接中…」、输入框显示「正在加载模型…」。hub 不安装 instance 模式包装，因此只有用户实例会出现该症状。

**登录页的 JSON 协议（不要退回读 302）**：登录页 JS 提交时带 `x-dsh-login-json: 1`，服务端回答 `200 {ok:true, target}`（同时下发与 302 路径完全相同的 Set-Cookie），由前端决定「同源 → 本标签跳转 / 跨端口 → 新窗口打开」；不带该头的纯表单提交仍走 302（无 JS 降级）。

原因：JS 读不到重定向的 `Location`——`fetch(…, {redirect:'manual'})` 返回的是 **opaque 响应（`status` 为 0、headers 不可读）**，而 `redirect:'follow'` 在跨端口（跨源）时响应同样不可读。若误用前者，症状是**点登录后新窗口一闪即关、仍停在登录页**（并显示 `请求失败（0）`）。因此跨端口目标必须由服务端显式下发。

## 运维接口

### hub 侧（3080）

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/dsh-login/login` | GET | 登录页（`?next=` 成功后的回跳目标；支持指向用户实例的绝对 URL） |
| `/dsh-login/login` | POST | 登录（JSON 或表单：`username`、`password`、`next`） |
| `/dsh-login/register` | POST | 注册（`username`、`password`、`password2`），成功后自动登录（普通用户直接进入其实例） |
| `/dsh-login/logout` | GET/POST | 退出 hub 会话 |
| `/dsh-login/state` | GET | `{authenticated, username?, admin?, db: "up"|"down", register, instance?: {port, running}}`（`admin` 供浏览器半边判定是否贡献右侧边栏入口） |
| `/dsh-login/health` | GET | `{ok: true, db: "up"|"down"}` |
| `/dsh-login/account` | GET | **账户中心**：当前登录身份与角色、（普通用户）自己的实例地址/状态、退出登录、（管理员）用户管理入口。未登录 302 到登录页 |
| `/dsh-login/users` | GET | **用户管理**（仅管理员）：全部账号（创建/最近登录时间）+ 实例（端口/运行状态）+ 操作：以该用户进入、打开、删除 |
| `/dsh-login/enter` | GET/POST | **以该用户身份进入**（仅管理员）：GET 渲染确认页（并先行确保实例就绪）；POST 铸造 handoff 302 到该用户实例。**不设置任何 hub 会话 cookie**——管理员的 hub 身份保持不变，浏览器同时持有两边会话 |
| `/dsh-login/users/delete` | POST | **删除用户**（仅管理员）：停止并删除其实例（进程 + `DSH_HOME` 目录）+ 删除 DB 行。禁止删除自己；Origin 校验 |
| `/dsh-login/users/status` | POST | **注册审批**（仅管理员）：`{user, action: "approve"\|"reject"}` → 把该账号置为 `approved`/`rejected`。管理员账号不可改；Origin 校验 |
| `/dsh-login/users/model-policy` | POST | **模型自设审批**（仅管理员）：`{user, allow: true\|false}` → 写 `model_self_service` 列 + 该用户 `DSH_HOME/dsh-login-model-policy.json` 镜像（实例立即生效，无需重启）。管理员账号无此开关；Origin 校验 |
| `/dsh-login/users` | GET | 表格含**状态**列、「通过/拒绝」按钮、**自行设置模型**列与「允许 / 禁止自行设置模型」按钮，以及"有 N 个账号等待审批"提示 |
| `/dsh-login/users/models` | GET/POST | **配置某用户的模型**（仅管理员，`?user=<名>`）：GET 显示该用户当前 provider/默认模型 + 表单；POST 校验后写入**该用户自己**的 `settings.yaml` + `.credentials.yaml`。见下节 |

### 为什么需要「配置某用户的模型」这一页

DSH 有意**只允许 loopback 页面编辑 host 的 settings/credentials**（`packages/client/connection/src/client/index.ts` 的 `isLoopback` 只看页面主机名；`packages/client/ui-settings/README.md`：*"Non-loopback pages get no durable settings … a scope starts `unavailable`"*）。因此经 LAN 域名（如 `192.168.0.50`）访问时，用户自己的「设置 → 模型」页必然报 *加载提供方目录失败: settings are unavailable in this browser*。服务器侧 API 本身可写（实测 LAN 下 `settings/describe` 返回 `writable: true`），被拦的只是浏览器端策略。

两条写入通道，走的是**同一套**校验与写入序列（`lib/model-config.js`）：

1. **用户自助**（用户实例侧 `/dsh-login/models`，见上表）：用户登录后在**自己的实例**页面上添加提供方——贴入模型公司官网签发的 API key（18 家内置预设一键添加，或自定义 provider），即可删除、设默认模型。插件经回环调用本实例自己的 `/api`（`selfRpc`，与 hub 的 `instanceRpc` 同一机制）。**需管理员先批准该用户的「自行设置模型」开关**，否则页面只读、写请求 403。
2. **管理员代管**（hub 侧本页）：管理员替用户写入同一套受校验的写入接口（**不受用户自设开关影响**，管理员始终可代管）：
   - hub 用共享签名密钥为该用户实例铸造一张 inner cookie（authority = `127.0.0.1:<实例端口>`），然后调用**该用户实例自己**的 `/api`：`settings/mutate`（`llm-pi-ai.providers.<id>`，可选 `agent-default-model`）与 `credentials/set`（`<ID>_API_KEY`）；
   - 实例未运行时保存会先 `ensure()`（首次供给约 30 秒~2 分钟）。

两条通道共同的约束：

- 只写目标用户 `DSH_HOME` 下的文件，绝不改 hub 或他人配置；实例在线时 settings 服务热加载，模型目录立即生效（无需重启实例）；
- 参数校验：provider 标识 `^[a-z][a-z0-9-]{1,31}$`、`baseURL` 必须 http(s)、模型 ID 非空、API key 须为可打印 ASCII（去首尾空白后）且不得是引号包裹/整行环境变量/超长；
- 写入顺序与 DSH 原生页一致：profile → key → 默认模型；删除时先 unset 凭据再 unset profile。

> 补充：若浏览器与实例同机，可直接用 `http://127.0.0.1:<端口>`（loopback）访问，此时 DSH 原生设置页本身可用。

### 用户实例侧（各用户端口）

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/dsh-login/health` | GET | `{ok: true, instance: true}`（hub 探活用） |
| `/dsh-login/state` | GET | `{authenticated, instance: true}` |
| `/dsh-login/account` | GET | **账户中心（实例侧）**：当前环境端口 + 「我的模型」入口（被管理员关闭时不提供链接）+ 开关状态标记 + 退出登录（完全退出）。需内置 cookie |
| `/dsh-login/models` | GET | **我的模型（用户自助）**：当前 provider 列表（含 API key 状态/默认标记）+ 默认模型 + 添加表单（内置预设 / 自定义）。**管理员关闭该功能时返回 403「管理员已关闭」页**。需内置 cookie，未登录 302 回 hub 登录页 |
| `/dsh-login/models` | POST | 保存新增/更新的 provider（表单或 JSON：`kind`、`presetId`/`providerId`、`displayName`、`api`、`baseURL`、`models`、`apiKey`、`setDefault`、`defaultModel`）。**只写本实例**的 `settings.yaml` + `.credentials.yaml`（经本实例自己的 `/api`）。未获批准一律 **403**（写入前判定）；Origin 校验；失败 400 回显表单（**不回显 key**）；成功 303 回本页 |
| `/dsh-login/models/delete` | POST | 删除 provider：`{id}`。功能被关闭时 **403**；先 `credentials/unset` 约定 ref（`<ID>_API_KEY`）再 unset profile（与 DSH 原生页同序）；不存在的 id 返回 `{ok:true, removed:false}`。Origin 校验 |
| `/dsh-login/models/default` | POST | 设默认模型：`{provider, model}`。功能被关闭时 **403**；写 `agent-default-model` 并 unset 残留的 `reasoningEffort`（沿用值会打断会话）。provider 须已配置。Origin 校验 |
| `/dsh-login/models/models-of` | GET | `?id=<provider>`：返回该 provider 的模型列表（内置预设走 pi-ai 本地目录，无网络调用；自定义/未知路由 503）。功能被关闭时 **403**。供页面填充默认模型下拉框 |
| `/dsh-login/logout` | GET/POST | 清除本实例内置 cookie，并**链到 hub 的 logout**（连同 hub 会话一起退出） |

### GUI 内的入口（悬浮按钮）

插件通过 DSH webserver 官方的 `webserver/index-inject` 注入机制，在**每个** `dsh web` 的 GUI 页面右下角注入一个「账户」悬浮按钮（hub 与用户实例都有）：

- hub（3080，管理员）：点「账户」→ 账户中心 → 「用户管理」；
- 用户实例（3100+）：点「账户」→ 实例账户中心（端口 + **我的模型** + 退出登录）。

按钮是静态注入（server 渲染进 index.html），页面内容按会话在**服务端**自适应，不需要额外 JS。

错误码（hub 侧）：400 参数错误 / 401 用户名或密码错误 / 403 来源不合法或注册关闭 / 409 用户名已存在 / 429 尝试过多 / 503 数据库不可用或**独立环境准备失败**（首次 provisioning 超时，重试即可）。

### 常用运维命令

```bash
# 列出所有用户实例及端口/PID
cat /srv/dsh-users/*/instance.json

# 查看某用户实例日志
tail -f /srv/dsh-users/<username>/web.log

# 手动停止某用户实例（其下次登录时 hub 会自动拉起）
kill "$(node -pe 'require("/srv/dsh-users/<username>/instance.json").pid')"

# 彻底删除某用户（先停实例，再删目录与 DB 行）
rm -rf /srv/dsh-users/<username>
# 然后删除 dsh_login 表中对应用户行
```

## 安装 / 升级

本插件位于 web profile 的 `vendor/dsh-login` 目录，并已纳入 profile 的 pnpm workspace（`pnpm-workspace.yaml` 的 `vendor/*`，profile 依赖 `"dsh-login": "workspace:*"`），`node_modules/dsh-login` 是指向本目录的符号链接：

1. 修改插件源码后**无需构建**（纯 ESM JS），也无需重新 `pnpm install`（符号链接即时生效），只需重启 `dsh web` 使插件代码生效；
2. `dsh-login.json` 配置在每次启动时读取，改完同样需要重启；
3. **注意**：用户实例里的插件是 provisioning 时的拷贝（pnpm `file:` 依赖）。hub 侧升级插件后，已存在的用户实例继续跑旧版本，直到该用户重新 provisioning（删除其 `/srv/dsh-users/<u>` 目录后重新登录）或在其 `profiles/web` 目录手工重跑 `pnpm install`。provisioning 每次都从 `$DSH_HOME/profiles/web/vendor/dsh-login` **重新拷贝当前源码**，因此「删目录 + 重新登录」即可让该用户拿到最新门禁（含 WebSocket `head` 透传修复）；hub 自身无需重启即可让后续 provisioning 生效；
4. 测试：`node --test test/gate.test.mjs`（会连接真实数据库，测试账号用后即删）；`node --test test/my-models.test.mjs`（用户自助模型页，纯假宿主、**不需要数据库**）。

## 安全说明

- 密码使用 scrypt（N=16384, r=8, p=1，16 字节随机盐）加盐哈希，数据库只存哈希；
- 所有 SQL 均使用参数化占位符；表名来自配置且经 `^[A-Za-z0-9_-]+$` 校验（SQL 中恒以反引号引用）；
- 登录页为同源 JSON 请求 + Origin 校验 + SameSite=Strict cookie，CSRF 风险面很小；
- 会话令牌、内置 cookie、handoff 均为 HttpOnly；
- 拒绝代理转发表头，防止经由转发代理伪造来源 IP 绕过 CIDR 限制；
- 数据库不可用时登录/注册失败关闭（fail closed），已有会话不受影响；
- **handoff 令牌**：v1 HMAC 签名（与内置 cookie 同源），10 分钟时效 + 一次性（实例内存记录已兑换令牌的 sha256，重启后清空，最坏情况是同一个过期窗口内的 handoff 可被重放一次——而它兑换后只是铸造一张用户本应拥有的 cookie）；
- handoff 出现在 URL 查询参数中，暴露面与 DSH 自带的启动令牌（`?token=`）相当；以短时效 + 一次性 + `Referrer-Policy: no-referrer` 缓解；
- 用户实例的内置 cookie 绑定自己的 authority（`Host:port`），跨实例、跨 hub 重放均会被拒绝（签名受众校验）；
- **管理员操作面**（`/dsh-login/users`、`/dsh-login/users/status`、`/dsh-login/users/model-policy`、`/dsh-login/enter`、`/dsh-login/users/delete`）三重门槛：有效 hub 会话 + 该会话属于 `adminUsers` +（POST）同源 Origin 校验；删除操作另禁止删除自己。`enter` 的 POST **不写任何 hub 会话 cookie**，因此管理员"以某用户身份进入"不会顶掉自己的 hub 身份；
- **信任模型说明**：hub 与所有用户实例共享同一 browser-session 签名密钥（provisioning 时以 `renderInstanceCredentials` 单独写入这一条记录），这是 hub 能铸造 handoff 的前提；除此之外用户实例不持有 hub 的任何凭据。该密钥等价于「对本机 GUI 的完全访问权」；启用 `instances.isolation: "uid"`（默认）后租户实例以各自的非特权 uid 运行（hub 仍是 root，租户之间互不相通），因此它不再等于「主机上的完全访问权」——租户只能触碰自己的 home（见「多租户隔离」）。
- **我的模型（用户自助页）**：不引入新权限——持有本实例内置 cookie 者本就能直接调该实例的 `/api`（门禁对 `/api` 一视同仁放行），页面只是把这些调用收进同一 Origin、同一 cookie 的受控表单：所有 POST 均有 Origin 同源校验；API key 只在表单提交时经回环传给本实例自己的 `/api`，页面任何渲染/回显都**不包含** key（失败回显仅保留除 key 外的字段）；预设表的 baseURL/模型 ID 是静态数据（来自 `lib/provider-presets.js`，与 pi-ai 目录核对一致），用户可自定义 baseURL 的能力类与管理员代管页、loopback 原生页完全相同（既有信任边界不变）。
- **模型自设开关**：它是**逐人的管理策略**，由实例侧在整条 `/dsh-login/models*` 路径上服务端强制（未批准时 GET 返回 403「已关闭」页、所有写路由与 `models-of` 一律 403，不只是隐藏按钮），镜像文件缺失/损坏按禁止处理（fail closed）。需要明确的边界是：它约束的是本插件的自助接口，而不是一个针对实例所有者的硬沙箱——实例以**该用户自己的非特权 uid** 运行（隔离只隔开租户之间与 hub，不隔开用户与自己的 home），其所有者本就能触碰同一份 `settings.yaml`/`.credentials.yaml` 与实例自身的 `/api`（见上一条的既有信任模型）。对普通用户「不许改模型」的强保证需要在操作系统/DSH 核心层面做隔离，不属于本插件的范围。

## 已知边界

- 数据库宕机且无有效会话时，任何人（含本机）都无法进入 GUI——这是有意的 fail-closed 行为；恢复数据库即可。
- 每个「浏览器 × 主机名」组合各自登录一次（cookie 按 Host 域隔离，浏览器标准行为）。
- 内置桥接 cookie 寿命 30 天（DSH 内置门禁默认值）；到期前本插件会话（7 天）已先失效，用户重新登录即自动续上。
- **每个用户实例是一个独立 node 进程**（常驻数百 MB 内存），适合中小规模用户数（单机几十人以内）；用户数多时再考虑改回单进程多租户。
- 管理员与普通用户**不能互相访问对方的工作区/会话**：管理员只有 hub（3080）上的内容，普通用户只有自己实例上的内容；hub 上的历史会话（如 `/root/test` 下的会话）仅管理员可见。启用 `instances.isolation: "uid"`（默认）后这条由 OS 权限强制：各租户 home 属主不同且 0700，hub 的 `/root` 与 `/root/.dsh` 仍 0700 root。
- 退出登录 = **完全退出**（两处已打通）：实例侧 `/dsh-login/logout` 清本实例内置 cookie 后**链到 hub 的 logout**，hub 侧 `/dsh-login/logout` 清 hub 会话并**同时清掉该 host 上各实例的内置 cookie**（最多 60 个），因此不会再出现"从实例退出登录后 hub 登录页仍显示已登录"。若浏览器仍留着某个实例 cookie（例如该实例已删除），它在到期前仍能访问那个实例——手动清该站点 cookie 即可。
- 注册自动登录时 `last_login_at` 保持 NULL（只有显式登录才更新该列），属既有行为。
- 用户实例端口稳定不变（`instance.json` 持久化）；若端口被其他长期占用，实例就绪探测会失败并在下次登录时报 503，处理掉占用或调高 `instances.portBase` 后重新 provisioning 即可。
- 用户实例镜像 `instances.checkout` 上 hub 的启动平面：hub 跑编译产物时，实例也跑 `apps/cli/lib/*`（checkout 的源码改动需要重新构建后**新启动**的实例才会生效）；hub 以 tsx 跑源码时实例跑源码。checkout 更新不影响运行中实例。
- 「我的模型」自助页是实例侧新增路由：升级插件后**已存在的用户实例**仍跑旧版插件（见「安装 / 升级」第 3 条），该用户重新 provisioning（删目录 + 重新登录）或在其 `profiles/web` 重跑 `pnpm install` 后才有此页（同理，模型自设开关也只有在实例跑新版插件后才会被强制）；升级前添加的 provider 数据不受影响（都在该用户的 `settings.yaml` 里）。升级后所有用户**默认禁止**自行设置模型，需管理员在「用户管理」里显式批准。
- 右下角「账户」悬浮按钮经 `webserver/index-inject` 注入；若未来 DSH webserver 移除/改名该注入事件，按钮不再出现，但所有 `/dsh-login/*` 页面仍可手动访问，功能不受影响。
- 「以该用户身份进入」是**管理员特权**（等同以该用户身份操作其环境）；仅建议在排障/代管时使用。被进入用户无法从环境中区分访问者是其本人还是管理员（同机同密钥的既有信任模型使然）。
