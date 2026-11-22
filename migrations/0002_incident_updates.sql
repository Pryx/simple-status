-- Status updates posted while an incident or maintenance is going on. "Started" is the
-- incident itself (starts_at and body); posting 'ended' also sets incidents.ends_at.
CREATE TABLE incident_updates (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('identified', 'monitoring', 'update', 'ended')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX incident_updates_incident_id ON incident_updates (incident_id, created_at);
