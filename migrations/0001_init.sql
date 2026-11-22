-- Timestamps are UTC ISO 8601 strings with milliseconds ("2026-11-22T10:00:00.000Z"),
-- so they sort and compare correctly as text.

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- Planned maintenance is an incident with impact 'maintenance'. There is no status
-- column: whether an incident is upcoming, active or ended follows from its times.
CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  impact TEXT NOT NULL CHECK (impact IN ('maintenance', 'minor_outage', 'major_outage')),
  starts_at TEXT NOT NULL,
  ends_at TEXT CHECK (ends_at IS NULL OR ends_at > starts_at),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX incidents_starts_at ON incidents (starts_at, id);
CREATE INDEX incidents_ends_at ON incidents (ends_at);

CREATE TABLE incident_services (
  incident_id TEXT NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES services (id) ON DELETE RESTRICT,
  PRIMARY KEY (incident_id, service_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX incident_services_service_id ON incident_services (service_id);

-- Status updates posted while an incident or maintenance is going on. "Started" is the
-- incident itself (starts_at and body). Posting 'ended' also sets incidents.ends_at.
CREATE TABLE incident_updates (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('identified', 'monitoring', 'update', 'ended')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX incident_updates_incident_id ON incident_updates (incident_id, created_at);

-- The public site is static files in R2. Writes queue the pages they affect here; the
-- Worker renders them right away, and a cron job picks up anything left over.
-- Keys: 'home', 'assets', 'incident:<id>', 'month:<YYYY-MM>'.
CREATE TABLE publish_queue (
  key TEXT PRIMARY KEY,
  queued_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- Small bits of state: the deployed version the site was rendered with, and when the
-- cron job last looked for incidents that started or ended on their own.
CREATE TABLE site_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- Who changed what in the admin, for internal tracking. Never published. Entries stay
-- when what they refer to is deleted (no foreign key), so deletions are recorded too.
CREATE TABLE activity (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  -- The incident or service it concerns, if any.
  subject_id TEXT,
  -- JSON: e.g. the title, the fields changed, an update's status.
  details TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE INDEX activity_subject_id ON activity (subject_id, id);
