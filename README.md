# Task Sync

This app keeps a local task list in sync with GitHub Issues. You can create and edit tasks in the dashboard, then push those changes to GitHub. Changes made in GitHub can be pulled back into the app as well.

## Run it locally

You need Node 18 or newer and a GitHub token that can read and write Issues in the repository you want to use.

```powershell
cd backend
copy .env.example .env
# Edit .env and fill in the GitHub values
npm install
npm start
```

In a second terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5173/` in a browser. The API runs on `http://localhost:5000` by default.

For webhooks, create a GitHub webhook for `/api/webhooks/github`, choose `application/json`, and use the same random value as `GITHUB_WEBHOOK_SECRET` in `.env`. The endpoint accepts only GitHub requests with a valid `X-Hub-Signature-256` header.

The backend saves its local state to `backend/data/state.json`. That file is created at runtime and is ignored by Git.

## How it works

The GitHub API code lives in `backend/githubProvider.js`. It adds the access token to each request, reads Issues 100 at a time, ignores pull requests, and retries temporary 429, rate-limit 403, and 5xx responses. The retry delay uses GitHub's `Retry-After` or reset header when available. New issues include a private task ID marker, so a retry after a network timeout can find an issue that GitHub already created instead of creating another one.

`backend/syncEngine.js` handles the actual sync work. A new or edited task is saved as `pending`. A sync pushes pending tasks first, then reads the provider pages and updates local tasks. The last completed pull time is saved as a cursor so the process can restart without losing its place.

A task that repeatedly fails is marked `error`; it does not stop the other tasks from syncing. The dashboard shows that state instead of claiming the task is synced. App deletes close the matching GitHub issue and keep a local tombstone so late events cannot recreate it.

## Conflict handling

This project uses manual conflict resolution. When a local edit is still pending and GitHub has a different newer version, the task becomes `conflict`. The dashboard shows buttons for keeping the local version or using the GitHub version.

Manual resolution is deliberate here. It prevents an edit from disappearing silently. A field-by-field merge would be a useful next step, but it would need rules for cases where both sides changed the same field.

## How I ensured sync correctness

- **Concurrent edits:** each task has a version number. PATCH and DELETE requests can include `If-Match`; an old version receives HTTP 409 instead of overwriting a newer edit. State writes are queued and written through a temporary file before the file is replaced.
- **Duplicate events:** GitHub delivery IDs are stored in `events`. Receiving the same webhook again returns `duplicate: true` and does not apply the event twice. GitHub issue numbers are used as the stable provider ID.
- **Deleted tasks:** a local delete leaves a tombstone. A late webhook for that issue is ignored, so an old event cannot bring the task back.
- **Retries:** temporary GitHub failures are retried up to five times. A permanent failure is recorded on that task and the rest of the queue can continue. Pending work remains on disk if the process stops, and the pull checkpoint is sent to GitHub as a `since` filter on the next run.

## Tests

```powershell
cd backend
npm test
```

The tests cover duplicate webhooks, deleted-task tombstones, stale concurrent updates, pagination, and temporary provider failures.

## Known limitations

The local store is a JSON file, so this setup is intended for one backend process. A production version should use a database and a job queue with leases. The current pull uses GitHub's `since` filter but still needs to scan each changed page; using GitHub events or conditional requests would make large repositories more efficient.
