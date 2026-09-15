const fs = require('node:fs/promises');
const path = require('node:path');

class Store {
  constructor(filePath = path.join(__dirname, 'data', 'state.json')) {
    this.filePath = filePath;
    this.state = { tasks: [], events: [], cursor: null };
    this.writeQueue = Promise.resolve();
  }

  async init() {
    try { this.state = JSON.parse(await fs.readFile(this.filePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await this.save(); }
    return this;
  }

  async save() {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      await fs.writeFile(tempPath, snapshot, 'utf8');
      await fs.rename(tempPath, this.filePath);
    });
    return this.writeQueue;
  }

  async update(mutator) { const result = await mutator(this.state); await this.save(); return result; }
  task(id) { return this.state.tasks.find((task) => task.id === id); }
  providerTask(providerId) { return this.state.tasks.find((task) => task.providerId === String(providerId)); }
  pending() { return this.state.tasks.filter((task) => task.syncStatus === 'pending'); }
}

module.exports = { Store };