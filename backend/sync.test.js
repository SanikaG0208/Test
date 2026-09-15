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