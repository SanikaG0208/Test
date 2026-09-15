const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('./store');
const { SyncEngine } = require('./syncEngine');
const { GithubProvider } = require('./githubProvider');

async function fixture(provider) {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'task-sync-')), 'state.json');
  const store = await new Store(file).init();
  return { store, sync: new SyncEngine(store, provider) };
}

const issue = { number: 7, title: 'Provider task', body: 'From GitHub', state: 'open', updated_at: '2026-09-15T10:00:00.000Z', html_url: 'https://github.com/acme/demo/issues/7' };

test('duplicate webhook delivery is idempotent', async () => {
  const { store, sync } = await fixture({});
  assert.deepEqual(await sync.webhook('delivery-1', { issue }), { duplicate: false });
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

test('optimistic versioning rejects stale concurrent update', async () => {
  const { store, sync } = await fixture({});
  const task = await sync.createTask({ title: 'Race' });
  await sync.updateTask(task.id, { title: 'First' }, 1);
  await assert.rejects(() => sync.updateTask(task.id, { title: 'Stale' }, 1), (error) => error.status === 409);
  assert.equal(store.task(task.id).title, 'First');
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