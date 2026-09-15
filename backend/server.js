const express = require('express');
const cors = require('cors');
require("dotenv").config();
const { Store } = require('./store');
const { GithubProvider } = require('./githubProvider');
const { SyncEngine } = require('./syncEngine');

async function createApp({ store = new Store(), provider = new GithubProvider() } = {}) {
  await store.init();
  const sync = new SyncEngine(store, provider);
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', githubConfigured: provider.configured }));
  app.get('/api/tasks', (req, res) => {
    const search = String(req.query.search || '').toLowerCase();
    const status = req.query.status;
    const tasks = store.state.tasks.filter((task) => (!status || task.syncStatus === status) && (!search || `${task.title} ${task.description}`.toLowerCase().includes(search)));
    res.json({ tasks, cursor: store.state.cursor });
  });
  app.post('/api/tasks', async (req, res) => res.status(201).json(await sync.createTask(req.body)));
  app.patch('/api/tasks/:id', async (req, res) => {
    try { const task = await sync.updateTask(req.params.id, req.body, req.headers['if-match']); res.status(task ? 200 : 404).json(task || { error: 'Task not found' }); }
    catch (error) { res.status(error.status || 500).json({ error: error.message, task: error.task }); }
  });
  app.delete('/api/tasks/:id', async (req, res) => {
    try { const task = await sync.deleteTask(req.params.id, req.headers['if-match']); res.status(task ? 200 : 404).json(task || { error: 'Task not found' }); }
    catch (error) { res.status(error.status || 500).json({ error: error.message, task: error.task }); }
  });
  app.post('/api/sync', async (_req, res) => { try { await sync.pushPending(); await sync.pull(); res.json({ ok: true, cursor: store.state.cursor }); } catch (error) { res.status(502).json({ error: error.message }); } });
  app.post('/api/tasks/:id/resolve', async (req, res) => res.json(await sync.resolveConflict(req.params.id, req.body.choice)));
  app.post('/api/webhooks/github', async (req, res) => { try { res.json(await sync.webhook(req.get('X-GitHub-Delivery'), req.body)); } catch (error) { res.status(400).json({ error: error.message }); } });
  return app;
}

if (require.main === module) createApp().then((app) => app.listen(process.env.PORT || 5000, () => console.log(`Backend running on http://localhost:${process.env.PORT || 5000}`)));
module.exports = { createApp };