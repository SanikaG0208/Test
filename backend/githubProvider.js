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
    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
      const retryAfter = Number(response.headers.get('retry-after')) || Math.min(30, 2 ** attempt);
      await this.sleep(retryAfter * 1000);
      return this.request(path, options, attempt + 1);
    }
    if (!response.ok) { const body = await response.text(); const error = new Error(`GitHub ${response.status}: ${body || response.statusText}`); error.status = response.status; throw error; }
    if (response.status === 204) return null;
    return response.json();
  }

  async listIssues() {
    const issues = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.request(`/repos/${this.owner}/${this.repo}/issues?state=all&per_page=100&page=${page}`);
      issues.push(...batch.filter((issue) => !issue.pull_request));
      if (batch.length < 100) return issues;
    }
  }

  async createIssue(task) { return this.request(`/repos/${this.owner}/${this.repo}/issues`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: task.title, body: task.description || '' }) }); }
  async updateIssue(providerId, task) { return this.request(`/repos/${this.owner}/${this.repo}/issues/${providerId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: task.title, body: task.description || '', state: task.status === 'done' ? 'closed' : 'open' }) }); }
}

function normalizeIssue(issue) { return { providerId: String(issue.number), title: issue.title, description: issue.body || '', status: issue.state === 'closed' ? 'done' : 'open', providerUpdatedAt: issue.updated_at, providerUrl: issue.html_url }; }

module.exports = { GithubProvider, normalizeIssue };