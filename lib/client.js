/**
 * dsh-login — browser half.
 *
 * The host half declares `dsh.client` in package.json, which makes the Web
 * shell serve this file and load it as a same-origin classic script. It
 * contributes exactly one right-Sidebar page type, "用户管理" (user
 * management), whose body embeds the host half's server-rendered admin
 * console (`/dsh-login/users`) in a same-origin iframe.
 *
 * ADMIN GATING: the whole GUI is served behind the login gate, so a page that
 * boots at all belongs to a signed-in account. One read of the host half's
 * `/dsh-login/state` therefore settles the question: when the account is an
 * administrator the type is registered, and otherwise nothing is contributed
 * and the right Sidebar shows no trace of it.
 *
 * The bundle is hand-written in the client module system's registration format
 * (`window.__ModuleLoader__.load({ id, factory })`) because this plugin
 * deliberately has no build step. The factory's `require` resolves the
 * shell-seeded baseline, so the half reaches React without declaring any
 * external module, and every other capability arrives through the injected
 * Cordis services (`slots`, `sidebarRightTabs`, `locale`).
 */
window.__ModuleLoader__.load({
	id: 'dsh-login',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		/** This implementation's identity in the tab system; also the body seat's key. */
		const USERS_ID = 'dsh-login/users';
		/** The type discriminator `sidebarRight.openTab()` names. */
		const USERS_KIND = 'dsh-login-users';
		/** This half's copy namespace. */
		const NS = 'dshLogin';

		const zh = {
			'users.title': '用户管理',
			'users.description': '审批注册账号、删除用户、分配模型',
			'users.frameTitle': '用户管理',
		};
		const en = {
			'users.title': 'User management',
			'users.description': 'Approve registrations, remove users, grant models',
			'users.frameTitle': 'User management',
		};

		/**
		 * The tab body: the admin console as served by the host half.
		 * @param props - framework-bound tab props carrying the copy seat.
		 * @returns the embedded console.
		 */
		function UsersBody(props) {
			const t = props.t === undefined ? (key) => key : props.t;
			const frame = {
				flex: '1 1 auto',
				width: '100%',
				height: '100%',
				minHeight: '360px',
				border: '0',
				background: 'transparent',
			};
			return react.createElement('div', {
				'data-dsh-login-users': '',
				style: { display: 'flex', width: '100%', height: '100%', minHeight: '360px' },
			}, react.createElement('iframe', {
				src: '/dsh-login/users',
				title: t('users.frameTitle'),
				style: frame,
			}));
		}

		/**
		 * Register the page type, its guide capsule, and its body.
		 * @param ctx - the client plugin context.
		 * @param t - namespace-bound translate for the type's copy.
		 * @returns one disposer releasing every registration.
		 */
		function registerAdminConsole(ctx, t) {
			const disposers = [
				ctx.sidebarRightTabs.register({
					id: USERS_ID,
					kind: USERS_KIND,
					priority: 'extension',
					title: () => t('users.title'),
					guide: [{
						id: USERS_ID,
						order: 30,
						title: () => t('users.title'),
						description: () => t('users.description'),
					}],
				}),
				ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
					name: 'sidebar.right.pane.tab',
					key: USERS_ID,
					locale: NS,
				}, UsersBody)),
			];
			return () => {
				for (const dispose of disposers.reverse()) dispose();
			};
		}

		/**
		 * Client plugin body.
		 * @param ctx - client root context carrying the slot registry, the right
		 *   Sidebar tab registry, and copy.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-login: dictionaries');
			const t = ctx.locale.bind(NS);
			// The role read is asynchronous, so the whole contribution is one async
			// effect: Cordis waits for the returned disposer and releases it with the
			// plugin when the page goes away.
			ctx.effect(async () => {
				let state;
				try {
					const response = await fetch('/dsh-login/state', {
						headers: { accept: 'application/json' },
						credentials: 'same-origin',
					});
					state = response.ok ? await response.json() : undefined;
				} catch {
					// Offline or logged out: contribute nothing.
					state = undefined;
				}
				if (state === undefined || state.admin !== true) return () => {};
				return registerAdminConsole(ctx, t);
			}, 'dsh-login: admin right-Sidebar console');
		}

		exports.apply = apply;
		exports.inject = ['slots', 'sidebarRightTabs', 'locale'];
		return module.exports;
	}
});
