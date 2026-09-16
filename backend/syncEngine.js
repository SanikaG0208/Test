const crypto = require('node:crypto');
const { normalizeIssue } = require('./githubProvider');
const now = () => new Date().toISOString();

class SyncEngine {
  constructor(store, provider) { this.store = store; this.provider = provider; this.running = false; }

  async createTask(input) {
    const timestamp = now();
    const task = { id: crypto.randomUUID(), title: input.title, description: input.description || '', status: input.status || 'open', version: 1, createdAt: timestamp, updatedAt: timestamp, syncStatus: 'pending', error: null, conflict: null, providerId: null };
    await this.store.update((state) => state.tasks.push(task));
    return task;
  }

  async updateTask(id, input, expectedVersion) {
    const task = this.store.task(id);
    if (!task) return null;
    await this.store.update(() => {
      if (expectedVersion !== undefined && Number(expectedVersion) !== task.version) { const error = new Error('Task changed since it was loaded'); error.status = 409; error.task = task; throw error; }
      Object.assign(task, { title: input.title ?? task.title, description: input.description ?? task.description, status: input.status ?? task.status, version: task.version + 1, updatedAt: now(), syncStatus: 'pending', error: null });
    });
    return task;
  }

  async deleteTask(id, expectedVersion) {
    const task = this.store.task(id);
    if (!task) return null;
    await this.store.update(() => {
      if (expectedVersion !== undefined && Number(expectedVersion) !== task.version) { const error = new Error('Task changed since it was loaded'); error.status = 409; error.task = task; throw error; }
      Object.assign(task, { deletedAt: now(), syncStatus: 'deleted', version: task.version + 1, updatedAt: now() });
    });
    return task;
  }

  async processTask(task) {
    try {
      const remote = task.providerId ? await this.provider.updateIssue(task.providerId, task) : await this.provider.createIssue(task);
      await this.store.update(() => Object.assign(task, { providerId: String(remote.number), providerUpdatedAt: remote.updated_at, providerUrl: remote.html_url, syncStatus: 'synced', error: null, conflict: null }));
    } catch (error) { await this.store.update(() => Object.assign(task, { syncStatus: 'error', error: error.message })); }
  }

  async processDeletedTask(task) {
    try {
      if (task.providerId) await this.provider.deleteIssue(task.providerId);
      await this.store.update(() => Object.assign(task, { syncStatus: 'deleted', error: null }));
    } catch (error) { await this.store.update(() => Object.assign(task, { syncStatus: 'error', error: error.message })); }
  }

  async pushPending() {
    if (this.running) return;
    this.running = true;
    try {
      for (const task of this.store.pending()) await this.processTask(task);
      for (const task of this.store.state.tasks.filter((item) => item.syncStatus === 'deleted' && item.providerId && !item.deleteSyncedAt)) {
        await this.processDeletedTask(task);
        if (task.syncStatus === 'deleted') { task.deleteSyncedAt = now(); await this.store.save(); }
      }
    } finally { this.running = false; }
  }

  async pull() {
    const remoteIssues = await this.provider.listIssues(this.store.state.cursor);
    await this.store.update((state) => {
      for (const issue of remoteIssues) {
        const remote = normalizeIssue(issue);
        const local = state.tasks.find((task) => task.providerId === remote.providerId);
        if (local?.deletedAt) continue;
        if (!local) state.tasks.push({ id: crypto.randomUUID(), ...remote, version: 1, updatedAt: remote.providerUpdatedAt, syncStatus: 'synced', error: null, conflict: null });
        else if (local.syncStatus === 'pending' && local.updatedAt !== remote.providerUpdatedAt) {
          local.syncStatus = 'conflict';
          local.conflict = { local: { title: local.title, description: local.description, status: local.status, updatedAt: local.updatedAt }, remote };
        } else if (local.syncStatus !== 'pending' && new Date(remote.providerUpdatedAt) > new Date(local.providerUpdatedAt || 0)) Object.assign(local, remote, { version: local.version + 1, updatedAt: remote.providerUpdatedAt, syncStatus: 'synced', error: null });
      }
      state.cursor = now();
    });
  }

  async resolveConflict(id, choice) {
    const task = this.store.task(id);
    if (!task || task.syncStatus !== 'conflict') return null;
    if (choice === 'remote') Object.assign(task, task.conflict.remote, { version: task.version + 1, updatedAt: now(), syncStatus: 'synced', conflict: null, error: null });
    else Object.assign(task, { syncStatus: 'pending', conflict: null, version: task.version + 1, updatedAt: now() });
    await this.store.save();
    if (choice !== 'remote') await this.pushPending();
    return task;
  }

  async webhook(deliveryId, payload) {
    if (!deliveryId) throw new Error('Missing X-GitHub-Delivery header');
    if (this.store.state.events.includes(deliveryId)) return { duplicate: true };
    await this.store.update((state) => state.events.push(deliveryId));
    if (!payload.issue) return { duplicate: false, ignored: true };
    const issue = normalizeIssue(payload.issue);
    const local = this.store.providerTask(issue.providerId);
    if (!local) await this.store.update((state) => state.tasks.push({ id: crypto.randomUUID(), ...issue, version: 1, updatedAt: issue.providerUpdatedAt, syncStatus: 'synced', error: null, conflict: null }));
    else if (local.deletedAt) return { duplicate: false, ignored: true };
    else if (local.syncStatus === 'pending') await this.store.update(() => Object.assign(local, { syncStatus: 'conflict', conflict: { local: { title: local.title, description: local.description, status: local.status, updatedAt: local.updatedAt }, remote: issue } }));
    else await this.store.update(() => Object.assign(local, issue, { version: local.version + 1, updatedAt: issue.providerUpdatedAt, syncStatus: 'synced', error: null }));
    return { duplicate: false };
  }
}

module.exports = { SyncEngine };