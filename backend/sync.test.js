const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('./store');
const { SyncEngine } = require('./syncEngine');
const { GithubProvider } = require('./githubProvider');
const { createApp } = require('./server');

async function fixture(provider) {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'task-sync-')), 'state.json');
  const store = await new Store(file).init();
  return { store, sync: new SyncEngine(store, provider) };
}

const issue = { number: 7, title: 'Provider task', body: 'From GitHub', state: 'open', updated_at: '2026-09-15T10:00:00.000Z', html_url: 'https://github.com/acme/demo/issues/7' };

test('three duplicate webhook deliveries are idempotent', async () => {
  const { store, sync } = await fixture({});
  assert.deepEqual(await sync.webhook('delivery-1', { issue }), { duplicate: false });
  assert.deepEqual(await sync.webhook('delivery-1', { issue }), { duplicate: true });
  assert.deepEqual(await sync.webhook('delivery-1', { issue }), { duplicate: true });
  assert.equal(store.state.tasks.length, 1);
  assert.equal(store.state.events.length, 1);
});

test('deleted local task is a tombstone and ignores late webhook', async () => {
  const { store, sync } = await fixture({});
  const task = await sync.webhook('delivery-2', { issue });
  const local = store.state.tasks[0];
  await sync.deleteTask(local.id, local.version);
  const result = await sync.webhook('delivery-3', { issue: { ...issue, title: 'Late update' } });
  assert.equal(result.ignored, true);
  assert.equal(store.state.tasks.length, 1);
  assert.equal(store.state.tasks[0].deletedAt !== undefined, true);
});

test('optimistic versioning rejects one of two concurrent updates', async () => {
  const { store, sync } = await fixture({});
  const task = await sync.createTask({ title: 'Race' });
  const results = await Promise.allSettled([
    sync.updateTask(task.id, { title: 'First' }, 1),
    sync.updateTask(task.id, { title: 'Second' }, 1),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.status === 409).length, 1);
  assert.equal(['First', 'Second'].includes(store.task(task.id).title), true);
});

test('local pending edit becomes a conflict when GitHub has changed', async () => {
  const provider = { listIssues: async () => [{ ...issue, title: 'GitHub title', updated_at: '2026-09-15T10:00:00.000Z' }] };
  const { store, sync } = await fixture(provider);
  const task = await sync.createTask({ title: 'Local title' });
  task.providerId = '7';
  task.providerUpdatedAt = '2026-09-15T09:00:00.000Z';
  await store.save();
  await sync.pull();
  assert.equal(store.task(task.id).syncStatus, 'conflict');
  assert.equal(store.task(task.id).conflict.local.title, 'Local title');
  assert.equal(store.task(task.id).conflict.remote.title, 'GitHub title');
});

test('provider paginates and retries transient failures', async () => {
  let calls = 0;
  const pages = [Array.from({ length: 100 }, (_, index) => ({ ...issue, number: index + 1 })), [{ ...issue, number: 101 }]];
  const provider = new GithubProvider({ token: 't', owner: 'o', repo: 'r', sleep: async () => {}, fetchImpl: async (_url) => {
    calls += 1;
    if (calls === 1) return { status: 503, ok: false, headers: { get: () => null }, text: async () => 'retry' };
    const page = calls === 2 ? pages[0] : pages[1];
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => page };
  } });
  assert.equal((await provider.listIssues()).length, 101);
  assert.equal(calls, 3);
});

test('provider backs off on GitHub rate-limit 403', async () => {
  let calls = 0;
  let waited = 0;
  const provider = new GithubProvider({ token: 't', owner: 'o', repo: 'r', sleep: async (ms) => { waited = ms; }, fetchImpl: async () => {
    calls += 1;
    if (calls === 1) return { status: 403, ok: false, headers: { get: (name) => name === 'x-ratelimit-remaining' ? '0' : '2000000000' }, text: async () => 'rate limited' };
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => [] };
  } });
  await provider.listIssues();
  assert.equal(calls, 2);
  assert.equal(waited > 0, true);
});

test('create recovery finds an issue after a previous timed-out create', async () => {
  let requested = [];
  const provider = new GithubProvider({ token: 't', owner: 'o', repo: 'r', fetchImpl: async (url, options = {}) => {
    requested.push({ url, options });
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => [{ ...issue, body: 'Description\n\n<!-- task-sync-id:task-1 -->' }] };
  } });
  const found = await provider.createIssue({ id: 'task-1', title: 'Retry me', description: 'Description' });
  assert.equal(found.number, 7);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].options.method, undefined);
});

test('delete propagation closes the provider issue', async () => {
  let request;
  const provider = new GithubProvider({ token: 't', owner: 'o', repo: 'r', fetchImpl: async (url, options) => {
    request = { url, options };
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ number: 7 }) };
  } });
  await provider.deleteIssue('7');
  assert.match(request.url, /issues\/7$/);
  assert.equal(JSON.parse(request.options.body).state, 'closed');
});

test('provider retries transient network failures', async () => {
  let calls = 0;
  let waited = 0;
  const provider = new GithubProvider({ token: 't', owner: 'o', repo: 'r', sleep: async (ms) => { waited = ms; }, fetchImpl: async () => {
    calls += 1;
    if (calls === 1) throw new Error('network timeout');
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => [] };
  } });
  await provider.listIssues();
  assert.equal(calls, 2);
  assert.equal(waited > 0, true);
});

test('ping webhook is accepted without an issue payload', async () => {
  const { store, sync } = await fixture({});
  assert.deepEqual(await sync.webhook('ping-1', { zen: 'Keep it logically awesome.' }), { duplicate: false, ignored: true });
  assert.equal(store.state.tasks.length, 0);
});

test('provider aborts and retries a hanging request', async () => {
  let calls = 0;
  const provider = new GithubProvider({ token: 't', owner: 'o', repo: 'r', requestTimeoutMs: 1, sleep: async () => {}, fetchImpl: async (_url, options) => {
    calls += 1;
    if (calls === 1) await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => [] };
  } });
  await provider.listIssues();
  assert.equal(calls, 2);
});

test('conflict resolution keeps local version and pushes it', async () => {
  let updated;
  const provider = {
    listIssues: async () => [{ ...issue, title: 'GitHub title', updated_at: '2026-09-15T10:00:00.000Z' }],
    updateIssue: async (_id, task) => { updated = task.title; return { number: 7, updated_at: '2026-09-15T11:00:00.000Z', html_url: issue.html_url }; },
  };
  const { store, sync } = await fixture(provider);
  const task = await sync.createTask({ title: 'Local title' });
  task.providerId = '7';
  task.providerUpdatedAt = '2026-09-15T09:00:00.000Z';
  await store.save();
  await sync.pull();
  const resolved = await sync.resolveConflict(task.id, 'local');
  assert.equal(updated, 'Local title');
  assert.equal(resolved.syncStatus, 'synced');
  assert.equal(resolved.conflict, null);
});

test('conflict resolution chooses the GitHub version', async () => {
  const provider = { listIssues: async () => [{ ...issue, title: 'GitHub title', updated_at: '2026-09-15T10:00:00.000Z' }] };
  const { store, sync } = await fixture(provider);
  const task = await sync.createTask({ title: 'Local title' });
  task.providerId = '7';
  task.providerUpdatedAt = '2026-09-15T09:00:00.000Z';
  await store.save();
  await sync.pull();
  const resolved = await sync.resolveConflict(task.id, 'remote');
  assert.equal(resolved.title, 'GitHub title');
  assert.equal(resolved.syncStatus, 'synced');
  assert.equal(resolved.conflict, null);
});

test('task CRUD API returns expected status codes', async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'task-api-')), 'state.json');
  const store = await new Store(file).init();
  const app = await createApp({ store, provider: { configured: true } });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const invalid = await fetch(`${baseUrl}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'missing title' }) });
    assert.equal(invalid.status, 400);
    const createdResponse = await fetch(`${baseUrl}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'API task', description: 'Created' }) });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    const updatedResponse = await fetch(`${baseUrl}/api/tasks/${created.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'If-Match': String(created.version) }, body: JSON.stringify({ title: 'Updated API task' }) });
    assert.equal(updatedResponse.status, 200);
    const deletedResponse = await fetch(`${baseUrl}/api/tasks/${created.id}`, { method: 'DELETE', headers: { 'If-Match': '2' } });
    assert.equal(deletedResponse.status, 200);
    const missingResponse = await fetch(`${baseUrl}/api/tasks/missing`);
    assert.equal(missingResponse.status, 404);
  } finally { server.close(); }
});

test('state and sync cursor survive a restart', async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'task-resume-')), 'state.json');
  const firstStore = await new Store(file).init();
  const firstSync = new SyncEngine(firstStore, {});
  const task = await firstSync.createTask({ title: 'Resume me' });
  const provider = { listIssues: async () => [] };
  await new SyncEngine(firstStore, provider).pull();
  const restartedStore = await new Store(file).init();
  assert.equal(restartedStore.task(task.id).title, 'Resume me');
  assert.equal(restartedStore.state.cursor !== null, true);
  assert.equal(restartedStore.pending().length, 1);
});

test('sync uses a cross-process lock boundary when the store provides one', async () => {
  let acquired = 0;
  let released = 0;
  const { store } = await fixture({});
  store.tryAcquireSyncLock = async () => { acquired += 1; return true; };
  store.releaseSyncLock = async () => { released += 1; };
  const sync = new SyncEngine(store, { listIssues: async () => [] });
  await sync.pushPending();
  assert.equal(acquired, 1);
  assert.equal(released, 1);
});