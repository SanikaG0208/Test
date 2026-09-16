const fs = require('node:fs/promises');
const path = require('node:path');

async function migrate(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const migrationDir = path.join(__dirname, 'db', 'migrations');
  const files = (await fs.readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
    if (applied.rowCount > 0) continue;
    const sql = await fs.readFile(path.join(migrationDir, file), 'utf8');
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  }
}

module.exports = { migrate };