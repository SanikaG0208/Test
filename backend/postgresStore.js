const { Pool } = require('pg');

const EMPTY_STATE = { tasks: [], events: [], cursor: null };

class PostgresStore {
  constructor(connectionString = process.env.DATABASE_URL) {
    if (!connectionString) throw new Error('DATABASE_URL is required for PostgreSQL storage.');
    this.pool = new Pool({ connectionString, max: Number(process.env.DB_POOL_MAX || 10) });
    this.state = structuredClone(EMPTY_STATE);
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS task_sync_state (
        id boolean PRIMARY KEY DEFAULT TRUE CHECK (id),
        state jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const result = await this.pool.query('SELECT state FROM task_sync_state WHERE id = TRUE');
    if (result.rowCount === 0) await this.pool.query('INSERT INTO task_sync_state (state) VALUES ($1::jsonb)', [JSON.stringify(EMPTY_STATE)]);
    else this.state = result.rows[0].state;
    return this;
  }

  async save() {
    const snapshot = JSON.stringify(this.state);
    this.writeQueue = this.writeQueue.then(() => this.pool.query(
      'UPDATE task_sync_state SET state = $1::jsonb, updated_at = now() WHERE id = TRUE',
      [snapshot],
    ));
    return this.writeQueue;
  }

  async update(mutator) { const result = await mutator(this.state); await this.save(); return result; }
  task(id) { return this.state.tasks.find((task) => task.id === id); }
  providerTask(providerId) { return this.state.tasks.find((task) => task.providerId === String(providerId)); }
  pending() { return this.state.tasks.filter((task) => ['pending', 'error'].includes(task.syncStatus)); }

  async close() { await this.pool.end(); }
}

module.exports = { PostgresStore };