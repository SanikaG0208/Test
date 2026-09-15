const API_ROOT = 'https://api.github.com';

class GithubProvider {
  constructor({ token, owner, repo, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    this.token = token || process.env.GITHUB_TOKEN;
    this.owner = owner || process.env.GITHUB_OWNER;
    this.repo = repo || process.env.GITHUB_REPO;
    this.fetch = fetchImpl;
    this.sleep = sleep;
  }

  get configured() { return Boolean(this.token && this.owner && this.repo); }

  async request(path, options = {}, attempt = 0) {
    if (!this.configured) throw new Error('GitHub is not set up yet. Add GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO to the backend .env file.');
    const response = await this.fetch(`${API_ROOT}${path}`, { ...options, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(options.headers || {}) } });
    const rateLimited = response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
    if ((rateLimited || response.status >= 500) && attempt < 5) {
      const resetAt = Number(response.headers.get('x-ratelimit-reset'));
      const resetDelay = resetAt ? Math.max(1, resetAt * 1000 - Date.now()) : 0;
      const retryAfter = Number(response.headers.get('retry-after')) * 1000 || resetDelay || Math.min(30000, 2 ** attempt * 1000);
      await this.sleep(retryAfter);
      return this.request(path, options, attempt + 1);
    }
    if (!response.ok) { const body = await response.text(); const error = new Error(`GitHub ${response.status}: ${body || response.statusText}`); error.status = response.status; throw error; }
    if (response.status === 204) return null;
    return response.json();
  }

  async listIssues(since) {
    const issues = [];
    for (let page = 1; ; page += 1) {
      const sinceQuery = since ? `&since=${encodeURIComponent(since)}` : '';
      const batch = await this.request(`/repos/${this.owner}/${this.repo}/issues?state=all&per_page=100&page=${page}${sinceQuery}`);
      issues.push(...batch.filter((issue) => !issue.pull_request));
      if (batch.length < 100) return issues;
    }
  }

  taskBody(task) { return `${task.description || ''}\n\n<!-- task-sync-id:${task.id} -->`; }

  async createIssue(task) {
    const existing = (await this.listIssues()).find((issue) => (issue.body || '').includes(`<!-- task-sync-id:${task.id} -->`));
    if (existing) return existing;
    return this.request(`/repos/${this.owner}/${this.repo}/issues`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: task.title, body: this.taskBody(task) }) });
  }

  async updateIssue(providerId, task) { return this.request(`/repos/${this.owner}/${this.repo}/issues/${providerId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: task.title, body: this.taskBody(task), state: task.status === 'done' ? 'closed' : 'open' }) }); }
  async deleteIssue(providerId) { return this.request(`/repos/${this.owner}/${this.repo}/issues/${providerId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'closed' }) }); }
}

function normalizeIssue(issue) { return { providerId: String(issue.number), title: issue.title, description: (issue.body || '').replace(/\n\n<!-- task-sync-id:[^>]+ -->\s*$/, ''), status: issue.state === 'closed' ? 'done' : 'open', providerUpdatedAt: issue.updated_at, providerUrl: issue.html_url }; }

module.exports = { GithubProvider, normalizeIssue };