CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY,
  provider_id text UNIQUE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL,
  sync_status text NOT NULL,
  error text,
  conflict jsonb,
  provider_updated_at timestamptz,
  provider_url text,
  deleted_at timestamptz,
  delete_synced_at timestamptz
);

CREATE TABLE IF NOT EXISTS sync_events (
  delivery_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  available_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, status)
);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  task_id uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  local_version jsonb NOT NULL,
  remote_version jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_state (
  key text PRIMARY KEY,
  value text
);