const { Pool } = require('pg');
const { migrate } = require('./migrate');

const EMPTY_STATE = { tasks: [], events: [], cursor: null };

class PostgresStore {
  constructor(connectionString = process.env.DATABASE_URL) {
    if (!connectionString) throw new Error('DATABASE_URL is required for PostgreSQL storage.');
    this.pool = new Pool({ connectionString, max: Number(process.env.DB_POOL_MAX || 10) });
    this.state = structuredClone(EMPTY_STATE);
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await migrate(this.pool);
    const tasks = await this.pool.query('SELECT * FROM tasks ORDER BY updated_at, id');
    const events = await this.pool.query('SELECT delivery_id FROM sync_events ORDER BY received_at');
    const cursor = await this.pool.query("SELECT value FROM sync_state WHERE key = 'pull_cursor'");
    if (tasks.rowCount === 0) await this.importLegacyState();
    else this.state = { tasks: tasks.rows.map(toTask), events: events.rows.map((row) => row.delivery_id), cursor: cursor.rows[0]?.value || null };
    return this;
  }

  async save() {
    this.writeQueue = this.writeQueue.then(() => this.persistState());
    return this.writeQueue;
  }

  async importLegacyState() {
    const legacy = await this.pool.query('SELECT state FROM task_sync_state WHERE id = TRUE').catch(() => ({ rowCount: 0 }));
    if (legacy.rowCount > 0) this.state = legacy.rows[0].state;
    await this.persistState();
  }

  async persistState() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const task of this.state.tasks) {
        await client.query(`INSERT INTO tasks (id, provider_id, title, description, status, version, created_at, updated_at, sync_status, error, conflict, provider_updated_at, provider_url, deleted_at, delete_synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (id) DO UPDATE SET provider_id=EXCLUDED.provider_id, title=EXCLUDED.title, description=EXCLUDED.description, status=EXCLUDED.status, version=EXCLUDED.version, created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at, sync_status=EXCLUDED.sync_status, error=EXCLUDED.error, conflict=EXCLUDED.conflict, provider_updated_at=EXCLUDED.provider_updated_at, provider_url=EXCLUDED.provider_url, deleted_at=EXCLUDED.deleted_at, delete_synced_at=EXCLUDED.delete_synced_at`, taskValues(task));
      }
      for (const deliveryId of this.state.events) await client.query('INSERT INTO sync_events (delivery_id) VALUES ($1) ON CONFLICT DO NOTHING', [deliveryId]);
      await client.query("INSERT INTO sync_state (key, value) VALUES ('pull_cursor', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [this.state.cursor]);
      await client.query('DELETE FROM sync_conflicts');
      for (const task of this.state.tasks.filter((item) => item.conflict)) await client.query('INSERT INTO sync_conflicts (task_id, local_version, remote_version) VALUES ($1,$2,$3)', [task.id, JSON.stringify(task.conflict.local), JSON.stringify(task.conflict.remote)]);
      await client.query('DELETE FROM sync_jobs');
      for (const task of this.state.tasks.filter((item) => ['pending', 'error'].includes(item.syncStatus))) await client.query('INSERT INTO sync_jobs (task_id, status, last_error) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [task.id, task.syncStatus, task.error]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async update(mutator) { const result = await mutator(this.state); await this.save(); return result; }
  task(id) { return this.state.tasks.find((task) => task.id === id); }
  providerTask(providerId) { return this.state.tasks.find((task) => task.providerId === String(providerId)); }
  pending() { return this.state.tasks.filter((task) => ['pending', 'error'].includes(task.syncStatus)); }

  async close() { await this.pool.end(); }
}

module.exports = { PostgresStore };

function taskValues(task) { return [task.id, task.providerId, task.title, task.description || '', task.status || 'open', task.version, task.createdAt || task.updatedAt, task.updatedAt, task.syncStatus, task.error, task.conflict ? JSON.stringify(task.conflict) : null, task.providerUpdatedAt || null, task.providerUrl || null, task.deletedAt || null, task.deleteSyncedAt || null]; }
function toTask(row) { return { id: row.id, providerId: row.provider_id, title: row.title, description: row.description, status: row.status, version: row.version, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), syncStatus: row.sync_status, error: row.error, conflict: row.conflict, providerUpdatedAt: row.provider_updated_at?.toISOString() || null, providerUrl: row.provider_url, deletedAt: row.deleted_at?.toISOString() || undefined, deleteSyncedAt: row.delete_synced_at?.toISOString() || undefined }; }