# Task Sync Console

Task Sync Console is a small full-stack task manager that synchronizes with a real GitHub Issues repository. The backend is the source of truth for local task state and exposes REST endpoints consumed by the React dashboard.

## Run locally

Requirements: Node 18+ and a GitHub personal access token with Issues read/write access.

```powershell
cd backend
copy .env.example .env
# Set GITHUB_TOKEN, GITHUB_OWNER and GITHUB_REPO in .env
npm install
node server.js

# In another terminal
cd frontend
npm install
npm run dev
```

The API runs at `http://localhost:5000` and Vite at `http://localhost:5173`. The backend stores state in `backend/data/state.json`; it is atomically replaced after every mutation and should not be committed.

## Architecture decisions

`GithubProvider` is the only module that knows GitHub's HTTP API. It sends authenticated requests, follows issue pages in batches of 100, filters pull requests, and retries 429/5xx responses with `Retry-After` or exponential backoff. A failed task is marked `error`, so one bad item does not stop the rest of the queue.

`SyncEngine` owns the bidirectional workflow. Local create/edit operations enqueue a task as `pending`; `POST /api/sync` pushes pending tasks in order and then pulls all provider pages. The saved `cursor` is a checkpoint for the last completed pull and is retained across restarts. GitHub webhooks can call `POST /api/webhooks/github` with `X-GitHub-Delivery`.

## Conflict policy

Conflicts use manual resolution. If a local task is pending and a newer provider version arrives, both versions are saved under `conflict`; the dashboard offers “Keep local” or “Keep GitHub”. This avoids silently losing a user edit, which is more important for task data than maximizing automatic throughput. A future field-level merge could merge title, description, and status independently, but would need a clear rule for incompatible edits.

## How I ensured sync correctness

- **Race conditions:** every task has a monotonic `version`. PATCH and DELETE accept `If-Match`; a stale version gets HTTP 409 and the current task, so concurrent edits cannot overwrite each other silently. File writes are serialized and use a temporary file plus rename.
- **Idempotency:** GitHub delivery IDs are persisted in `events`, so replayed webhooks return `duplicate: true` without changing state. Provider issue numbers are the stable external identity. App deletes create tombstones, preventing late webhooks from resurrecting a task.
- **Retries:** transient 429 and 5xx provider responses retry up to five times with backoff. Permanent failures quarantine only the affected task as `error`. Sync can be run again after a process crash; pending tasks remain persisted and the last pull checkpoint remains visible.

## Tests

```powershell
cd backend
npm test
```

Tests cover duplicate webhooks, deletion tombstones, optimistic concurrency, pagination, and transient provider failures.

## Known limitations / what I'd do with more time

The demo uses a JSON store rather than Postgres, so it is designed for one API process and does not provide database-level transactions across multiple instances. GitHub webhook signature verification and a background job process with durable leases should be added before production. Pull currently scans all issue pages after the checkpoint; I would use GitHub's event API or conditional requests for a more efficient incremental cursor. The provider needs a repository label/metadata mapping for richer task fields and the frontend would benefit from real-time push updates.