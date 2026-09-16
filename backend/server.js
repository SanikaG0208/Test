const express = require('express');
const cors = require('cors');
const crypto = require('node:crypto');
require("dotenv").config();
const { Store } = require('./store');
const { PostgresStore } = require('./postgresStore');
const { GithubProvider } = require('./githubProvider');
const { SyncEngine } = require('./syncEngine');

async function createApp({ store = process.env.DATABASE_URL ? new PostgresStore() : new Store(), provider = new GithubProvider() } = {}) {
  await store.init();
  const sync = new SyncEngine(store, provider);
  const app = express();

  app.use(cors());
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = buffer; } }));
  app.get('/', (_req, res) => res.json({ message: 'Task Sync API is running.', health: '/api/health' }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', githubConfigured: provider.configured }));
  app.get('/api/tasks', (req, res) => {
    const search = String(req.query.search || '').toLowerCase();
    const status = req.query.status;
    const tasks = store.state.tasks.filter((task) => (!status || task.syncStatus === status) && (!search || `${task.title} ${task.description}`.toLowerCase().includes(search)));
    res.json({ tasks, cursor: store.state.cursor });
  });
  app.get('/api/tasks/:id', (req, res) => {
    const task = store.task(req.params.id);
    res.status(task ? 200 : 404).json(task || { error: 'Task not found' });
  });
  app.post('/api/tasks', async (req, res) => {
    const validation = validateTaskInput(req.body, false);
    if (validation) return res.status(400).json({ error: validation });
    res.status(201).json(await sync.createTask(req.body));
  });
  app.patch('/api/tasks/:id', async (req, res) => {
    const validation = validateTaskInput(req.body, true);
    if (validation) return res.status(400).json({ error: validation });
    try { const task = await sync.updateTask(req.params.id, req.body, req.headers['if-match']); res.status(task ? 200 : 404).json(task || { error: 'Task not found' }); }
    catch (error) { res.status(error.status || 500).json({ error: error.message, task: error.task }); }
  });
  app.delete('/api/tasks/:id', async (req, res) => {
    try { const task = await sync.deleteTask(req.params.id, req.headers['if-match']); res.status(task ? 200 : 404).json(task || { error: 'Task not found' }); }
    catch (error) { res.status(error.status || 500).json({ error: error.message, task: error.task }); }
  });
  app.post('/api/sync', async (_req, res) => { try { await sync.pushPending(); await sync.pull(); res.json({ ok: true, cursor: store.state.cursor }); } catch (error) { res.status(502).json({ error: error.message }); } });
  app.get('/api/tasks/:id/conflict', (req, res) => {
    const task = store.task(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.syncStatus !== 'conflict' || !task.conflict) return res.status(404).json({ error: 'Task has no conflict' });
    res.json({ taskId: task.id, ...task.conflict });
  });
  app.post('/api/tasks/:id/resolve', async (req, res) => {
    if (!['local', 'remote'].includes(req.body?.choice)) return res.status(400).json({ error: 'choice must be local or remote' });
    const task = await sync.resolveConflict(req.params.id, req.body.choice);
    res.status(task ? 200 : 404).json(task || { error: 'Conflict not found' });
  });
  app.post('/api/webhooks/github', async (req, res) => {
    try {
      const secret = process.env.GITHUB_WEBHOOK_SECRET;
      const signature = req.get('X-Hub-Signature-256');
      if (!secret || !signature) return res.status(401).json({ error: 'Webhook signing is not configured.' });
      const expected = `sha256=${crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex')}`;
      if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return res.status(401).json({ error: 'Webhook signature is invalid.' });
      res.json(await sync.webhook(req.get('X-GitHub-Delivery'), req.body));
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  return app;
}

function validateTaskInput(input, partial) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Request body must be a JSON object.';
  if (!partial && (typeof input.title !== 'string' || !input.title.trim())) return 'title is required and must be a non-empty string.';
  if (partial && input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim())) return 'title must be a non-empty string.';
  if (input.description !== undefined && typeof input.description !== 'string') return 'description must be a string.';
  if (input.status !== undefined && !['open', 'done'].includes(input.status)) return 'status must be open or done.';
  return null;
}

if (require.main === module) createApp().then((app) => app.listen(process.env.PORT || 5000, () => console.log(`Backend running on http://localhost:${process.env.PORT || 5000}`)));
module.exports = { createApp };