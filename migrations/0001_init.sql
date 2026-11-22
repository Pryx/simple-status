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
