/** 控制台网络、动作确认与真实 React 生命周期的最小 Node 假体回归。 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const sources = Object.fromEntries(['lib/api.ts', 'lib/useConsole.ts', 'App.tsx'].map(file => [file, fs.readFileSync(path.join(root, 'src', file), 'utf8')]));
const compiled = new Map();
function compile(file, change = source => source) {
  const source = change(sources[file]);
  if (!compiled.has(source)) compiled.set(source, ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText);
  return compiled.get(source);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
const user = { id: 'admin', subject: 'admin', displayName: '管理员', isAdmin: true };
const license = { id: 'license', code: 'DSH-TEST', status: 'active' };
const device = { id: 'device', deviceId: 'phone', deviceName: '手机' };
function json(body, status = 200) { return { status, ok: status >= 200 && status < 300, text: async () => status === 204 ? '' : JSON.stringify(body) }; }
function aborting(signal) {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException('cancelled', 'AbortError'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
function fakeReact() {
  const cells = [];
  let index = 0, pending = [];
  const same = (a, b) => a && a.length === b.length && a.every((value, i) => value === b[i]);
  const react = {
    useRef(value) { const at = index++; return cells[at] ??= { current: value }; },
    useState(value) {
      const at = index++;
      if (!(at in cells)) cells[at] = typeof value === 'function' ? value() : value;
      return [cells[at], next => { cells[at] = typeof next === 'function' ? next(cells[at]) : next; }];
    },
    useCallback(fn, deps) {
      const at = index++;
      if (!same(cells[at]?.deps, deps)) cells[at] = { value: fn, deps };
      return cells[at].value;
    },
    useEffect(work, deps) {
      const at = index++;
      if (!same(cells[at]?.deps, deps)) {
        cells[at]?.cleanup?.();
        cells[at] = { deps, work, cleanup: null };
        pending.push(cells[at]);
      }
    },
  };
  return {
    react,
    render(work) { index = 0; const result = work(); const effects = pending; pending = []; effects.forEach(cell => { cell.cleanup = cell.work(); }); return result; },
    cleanup() { cells.forEach(cell => cell?.cleanup?.()); },
    strictRestart() { cells.forEach(cell => { if (cell?.work) { cell.cleanup?.(); cell.cleanup = cell.work(); } }); },
  };
}
function host(change = {}) {
  const hooks = fakeReact(), timers = new Map(), intervals = new Map(), events = new Map(), calls = [];
  let next = 0, licenseStatus = 'active', bound = true;
  const document = {
    visibilityState: 'visible',
    addEventListener(name, fn) { events.set(name, fn); },
    removeEventListener(name, fn) { if (events.get(name) === fn) events.delete(name); },
  };
  const defaults = (url, init) => {
    const route = url.replace('/api/platform/v1', '');
    if (route === '/me') return json({ ok: true, user });
    if (route === '/overview') return json({ ok: true, role: 'master', version: 'test' });
    if (route === '/licenses') return json({ ok: true, licenses: [{ ...license, status: licenseStatus }] });
    if (route === '/nodes') return json({ ok: true, nodes: [] });
    if (route === '/licenses/license/status') { licenseStatus = licenseStatus === 'active' ? 'revoked' : 'active'; return json({ ok: true, status: licenseStatus }); }
    if (route === '/licenses/license/devices') return json({ ok: true, devices: bound ? [device] : [] });
    if (route === '/licenses/license/devices/phone' && init.method === 'DELETE') { bound = false; return json({ ok: true, removed: true }); }
    if (route === '/auth/logout') return json(null, 204);
    throw new Error(`unexpected request ${route}`);
  };
  const state = {
    hooks, timers, intervals, document, calls, defaults,
    fetch: defaults,
    visible(value) { document.visibilityState = value; events.get('visibilitychange')?.(); },
    poll() { [...intervals.values()].forEach(fn => fn()); },
    timeout() { [...timers.entries()].forEach(([id, fn]) => { timers.delete(id); fn(); }); },
  };
  const common = {
    AbortController, DOMException, Error, Date, Promise, console,
    document,
    fetch: (url, init) => { calls.push({ url, init }); return Promise.resolve().then(() => state.fetch(url, init)); },
    setTimeout: fn => { const id = ++next; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { assert.equal(ms, 30_000); const id = ++next; intervals.set(id, fn); return id; },
    clearInterval: id => intervals.delete(id),
  };
  const modules = {};
  function load(file) {
    if (modules[file]) return modules[file];
    const exports = {};
    vm.runInNewContext(compile(file, change[file]), { ...common, exports, require: name => {
      if (name === 'react') return hooks.react;
      if (name === './api.ts') return load('lib/api.ts');
      throw new Error(name);
    } }, { filename: file });
    modules[file] = exports;
    return exports;
  }
  state.api = load('lib/api.ts');
  state.hook = load('lib/useConsole.ts');
  state.render = () => hooks.render(state.hook.useConsole);
  return state;
}

async function boot(h) { h.render(); await settle(); return h.render(); }
const routeCalls = (h, route) => h.calls.filter(call => call.url.endsWith(route));

test('CONSOLE13 首屏网络失败可重试，只有明确401进入登录页', async () => {
  const h = host();
  h.fetch = () => { throw new TypeError('offline'); };
  let view = await boot(h);
  assert.equal(view.user, null); assert.equal(view.signedOut, false); assert.equal(view.checking, false);
  assert.match(view.error, /网络/);
  h.fetch = h.defaults;
  await view.refresh(); view = h.render();
  assert.equal(view.user.id, 'admin');
  h.fetch = () => json({ error: 'expired' }, 401);
  await view.refresh(); view = h.render();
  assert.equal(view.user, null); assert.equal(view.signedOut, true); assert.equal(view.licenses.length, 0);
  h.hooks.cleanup();
});

test('CONSOLE13/18 5xx、非JSON与轮询失败保留旧数据和用户', async () => {
  const h = host(); let view = await boot(h);
  for (const response of [() => json({ error: 'unavailable' }, 503), () => ({ ok: true, status: 200, text: async () => '<html>portal</html>' })]) {
    h.fetch = response;
    await view.refresh(); view = h.render();
    assert.equal(view.user.id, 'admin'); assert.equal(view.licenses[0].id, 'license'); assert.equal(view.signedOut, false);
  }
  const error = view.error;
  h.poll(); await settle(); view = h.render();
  assert.equal(view.error, error); assert.equal(view.licenses[0].id, 'license');
  h.hooks.cleanup();
});

test('CONSOLE14 超时覆盖响应正文，外部取消独立可识别并清理计时器', async () => {
  const h = host();
  h.fetch = (_, init) => ({ status: 200, ok: true, text: () => aborting(init.signal) });
  const request = h.api.fetchMe(); await settle();
  assert.equal(h.timers.size, 1); h.timeout();
  await assert.rejects(request, error => error instanceof h.api.NetworkError && /超时/.test(error.message));
  assert.equal(h.timers.size, 0);
  const controller = new AbortController();
  const cancelled = h.api.fetchMe(controller.signal); await settle(); controller.abort();
  await assert.rejects(cancelled, error => h.api.isCancelled(error));
  assert.equal(h.timers.size, 0);
});

test('CONSOLE14 StrictMode旧轮与卸载请求被取消，迟到结果不覆盖新轮', async () => {
  const h = host(), old = deferred(); let count = 0;
  h.fetch = (url, init) => url.endsWith('/me') && count++ === 0 ? old.promise : h.defaults(url, init);
  h.render(); await settle(); const first = h.calls[0].init.signal;
  h.hooks.strictRestart(); await settle();
  assert.equal(first.aborted, true);
  let view = h.render(); assert.equal(view.user.id, 'admin');
  old.resolve(json({ ok: true, user: { ...user, id: 'stale' } })); await settle();
  assert.equal(h.render().user.id, 'admin');
  h.fetch = (_, init) => aborting(init.signal);
  const refreshing = view.refresh(); await settle(); h.hooks.cleanup(); await refreshing;
  assert.equal(h.calls.at(-1).init.signal.aborted, true);
  assert.equal(h.intervals.size, 0); assert.equal(h.timers.size, 0);
});

test('CONSOLE15 动作已成功但刷新失败时锁住toggle，手动刷新后才允许下一次', async () => {
  const h = host(); let view = await boot(h), failReads = false;
  h.fetch = (url, init) => {
    if (url.endsWith('/status')) { failReads = true; return h.defaults(url, init); }
    if (failReads) throw new TypeError('offline');
    return h.defaults(url, init);
  };
  const toggle = signal => h.api.toggleLicense('license', signal).then(() => {});
  await view.run(toggle); view = h.render();
  assert.match(view.error, /操作已完成，刷新失败/); assert.equal(view.busy, true); assert.equal(view.working, false);
  await view.run(toggle); assert.equal(routeCalls(h, '/status').length, 1);
  failReads = false; await view.refresh(); view = h.render();
  assert.equal(view.licenses[0].status, 'revoked'); assert.equal(view.busy, false);
  h.hooks.cleanup();
});

test('CONSOLE15 写超时只刷新确认，不自动重发；双击与旧快照不能越过动作锁', async () => {
  const h = host(); let view = await boot(h);
  h.fetch = (url, init) => url.endsWith('/status') ? aborting(init.signal) : h.defaults(url, init);
  const action = signal => h.api.toggleLicense('license', signal).then(() => {});
  const first = view.run(action); const second = view.run(action);
  await settle(); h.timeout(); await first; await second; view = h.render();
  assert.equal(routeCalls(h, '/status').length, 1); assert.match(view.error, /操作结果尚未确认/);
  assert.equal(view.busy, false);
  const late = deferred();
  h.fetch = (url, init) => url.endsWith('/licenses') && !init.method ? late.promise : h.defaults(url, init);
  const reading = view.refresh(); await settle();
  const running = view.run(async signal => { assert.equal(signal.aborted, false); }); await settle();
  h.fetch = h.defaults;
  late.resolve(json({ ok: true, licenses: [{ ...license, status: 'stale' }] }));
  await reading; await running; view = h.render();
  assert.notEqual(view.licenses[0].status, 'stale');
  h.hooks.cleanup();
});

test('CONSOLE15 DevicesPanel解绑共用动作确认链，刷新失败不重复解绑', async () => {
  const h = host(); let view = await boot(h);
  view.chooseLicense(license); await settle(); view = h.render(); assert.equal(view.devices.length, 1);
  let failReads = false;
  h.fetch = (url, init) => {
    if (init.method === 'DELETE') { failReads = true; return h.defaults(url, init); }
    if (failReads) throw new TypeError('offline');
    return h.defaults(url, init);
  };
  const unbind = signal => h.api.unbindDevice('license', 'phone', signal).then(() => {});
  await view.run(unbind); view = h.render();
  assert.match(view.error, /操作已完成，刷新失败/); assert.equal(view.devices.length, 1);
  await view.run(unbind); assert.equal(h.calls.filter(call => call.init.method === 'DELETE').length, 1);
  failReads = false; await view.refresh(); view = h.render(); assert.equal(view.devices.length, 0);
  h.hooks.cleanup();
});

test('CONSOLE16 节点使用自身周期，缺失、未来时间和移除均不伪报在线', () => {
  const h = host(), now = Date.parse('2026-11-20T00:00:00Z');
  const node = { tunnelOnline: true, lastSeenAt: new Date(now - 181_000).toISOString(), reportIntervalSeconds: 60 };
  assert.match(h.hook.nodeStatus(node, now).text, /失联/);
  assert.equal(h.hook.nodeStatus({ ...node, reportIntervalSeconds: 300 }, now).online, true);
  assert.equal(h.hook.nodeStatus({ ...node, reportIntervalSeconds: null }, now).text, '上报周期未知');
  assert.equal(h.hook.nodeStatus({ ...node, lastSeenAt: new Date(now + 1).toISOString() }, now).text, '上报时间异常');
  assert.equal(h.hook.nodeStatus({ ...node, revokedAt: 'removed' }, now).online, false);
});

test('CONSOLE18 隐藏页暂停、可见立即刷新，同轮读不重叠', async () => {
  const h = host(); let view = await boot(h); const count = h.calls.length;
  h.visible('hidden'); h.poll(); await settle(); assert.equal(h.calls.length, count);
  const waiting = deferred();
  h.fetch = (url, init) => url.endsWith('/overview') ? waiting.promise : h.defaults(url, init);
  h.visible('visible'); await settle(); const active = h.calls.length;
  h.poll(); void view.refresh(); await settle(); assert.equal(h.calls.length, active);
  waiting.resolve(json({ ok: true, role: 'master', version: 'fresh' })); await settle(); view = h.render();
  assert.equal(view.overview.version, 'fresh'); h.hooks.cleanup();
});

test('CONSOLE21 登出检查HTTP失败，204成功才清本地会话', async () => {
  const h = host(); let view = await boot(h);
  h.fetch = (url, init) => url.endsWith('/auth/logout') ? json({ error: 'denied' }, 403) : h.defaults(url, init);
  await view.signOut(); view = h.render(); assert.equal(view.user.id, 'admin');
  h.fetch = h.defaults; await view.signOut(); view = h.render();
  assert.equal(view.user, null); assert.equal(view.signedOut, true);
  h.hooks.cleanup();
});

test('真实UI按钮复用请求signal，设备面板没有另起解绑刷新链', async () => {
  const h = host();
  const jsx = (type, props) => ({ type, props });
  const exports = {};
  vm.runInNewContext(compile('App.tsx'), { exports, require: name => {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
    if (name.endsWith('useConsole.ts')) return { ...h.hook, useConsole: () => ({
      user, signedOut: false, checking: false, overview: { role: 'master' }, licenses: [license], nodes: [], selected: license, devices: [device],
      error: '', now: Date.now(), busy: false, working: false, refreshing: false,
      refresh() {}, chooseLicense() {}, signOut() {}, run: action => action(new AbortController().signal),
    }) };
    if (name.endsWith('api.ts')) return h.api;
    if (name.endsWith('format.ts')) return { admissionText: x => x, admissionTone: () => 'ok', licenseText: x => x, licenseTone: () => 'ok', timeText: x => x };
    if (name.endsWith('blocks.tsx')) return Object.fromEntries(['Card', 'Dot', 'Empty', 'InfoList', 'InfoRow', 'ToneValue'].map(x => [x, x]));
    if (name === '@appica/ui-react/spinner') return { Spinner: 'Spinner' };
    throw new Error(name);
  } });
  function expand(node) {
    if (Array.isArray(node)) return node.flatMap(expand);
    if (!node || typeof node !== 'object') return [];
    if (typeof node.type === 'function') return expand(node.type(node.props));
    return [node, ...expand(node.props?.children)];
  }
  const tree = expand(exports.App());
  const unbind = tree.find(node => node.type === 'button' && node.props.children === '解绑');
  assert.ok(unbind); unbind.props.onClick(); await settle();
  assert.equal(h.calls.filter(call => call.init.method === 'DELETE').length, 1);
  assert.ok(h.calls[0].init.signal instanceof AbortSignal);
  assert.equal(sources['App.tsx'].includes('.then(refresh)'), false);
});

test('变异证明：去掉动作后锁定或把网络失败当登出会破坏真实链路', async () => {
  const unlocked = host({ 'lib/useConsole.ts': source => source.replaceAll('scope.locked = true', 'scope.locked = false') });
  let view = await boot(unlocked), writes = 0;
  unlocked.fetch = () => { throw new TypeError('offline'); };
  const action = async () => { writes++; };
  await view.run(action); await view.run(action); assert.equal(writes, 2, '生产断言要求只有一次写入，此变异能被观察');
  unlocked.hooks.cleanup();
  const loggedOut = host({ 'lib/useConsole.ts': source => source.replace('error instanceof ApiError && error.status === 401) clearSession(scope)', 'true) clearSession(scope)') });
  loggedOut.fetch = () => { throw new TypeError('offline'); };
  view = await boot(loggedOut); assert.equal(view.signedOut, true, '生产断言要求保留未确认登录态');
  loggedOut.hooks.cleanup();
});
