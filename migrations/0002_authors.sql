-- Who created each incident and posted each update (the Access email, or "name (v2)"
-- for imported history). Shown in the admin only; never published.
ALTER TABLE incidents ADD COLUMN created_by TEXT;
ALTER TABLE incident_updates ADD COLUMN created_by TEXT;

-- Fill them in for existing data from the activity log.
UPDATE incidents SET created_by = (
  SELECT actor FROM activity
  WHERE action = 'incident.created' AND subject_id = incidents.id
  ORDER BY id LIMIT 1
);

-- The log doesn't name the update, so match on incident, status and time.
UPDATE incident_updates SET created_by = (
  SELECT actor FROM activity
  WHERE action = 'update.posted' AND subject_id = incident_updates.incident_id
    AND json_extract(details, '$.status') = incident_updates.status
    AND abs(julianday(at) - julianday(incident_updates.created_at)) < 10.0 / 86400
  ORDER BY abs(julianday(at) - julianday(incident_updates.created_at))
  LIMIT 1
);
