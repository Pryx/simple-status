-- Example data for trying the app locally: npm run demo:setup, then npm run demo.
-- It goes into a separate local database (.wrangler/demo), never into your real one.
DELETE FROM incident_updates;
DELETE FROM incident_services;
DELETE FROM incidents;
DELETE FROM services;
DELETE FROM activity;

INSERT INTO services (id, name, description, position, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Website', 'Public website', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('00000000-0000-4000-8000-000000000002', 'API', 'REST API for customers', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('00000000-0000-4000-8000-000000000003', 'Email', '', 2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO incidents (id, title, body, impact, starts_at, ends_at, created_at, updated_at) VALUES
  ('00000000-0000-4000-9000-000000000001', 'Slow API responses',
   'Some requests take **several seconds**. We are investigating.',
   'minor_outage', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes'), NULL,
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('00000000-0000-4000-9000-000000000002', 'Database upgrade',
   'The website will be read-only during the upgrade.',
   'maintenance', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+2 days'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+2 days', '+1 hour'),
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('00000000-0000-4000-9000-000000000003', 'Email delivery outage',
   'Outgoing email was not delivered. All queued messages have been sent.',
   'major_outage', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days', '+2 hours'),
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO incident_services (incident_id, service_id) VALUES
  ('00000000-0000-4000-9000-000000000001', '00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-9000-000000000002', '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-9000-000000000003', '00000000-0000-4000-8000-000000000003');

INSERT INTO incident_updates (id, incident_id, status, body, created_at) VALUES
  ('00000000-0000-4000-a000-000000000001', '00000000-0000-4000-9000-000000000001', 'identified',
   'Responses are slow for requests that list orders.', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 minutes')),
  ('00000000-0000-4000-a000-000000000002', '00000000-0000-4000-9000-000000000001', 'identified',
   'A database index was missing after last night''s deploy. We are rebuilding it.', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes')),
  ('00000000-0000-4000-a000-000000000003', '00000000-0000-4000-9000-000000000003', 'identified',
   'Our email provider has an outage.', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days', '+30 minutes')),
  ('00000000-0000-4000-a000-000000000004', '00000000-0000-4000-9000-000000000003', 'ended',
   'The provider has recovered and the queue has been sent.', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days', '+2 hours'));

-- Past incidents over the last few months, to try the history and infinite scroll.
INSERT INTO incidents (id, title, body, impact, starts_at, ends_at, created_at, updated_at)
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 14)
SELECT
  printf('00000000-0000-4000-b000-%012d', i),
  CASE i % 4
    WHEN 0 THEN 'Scheduled database maintenance'
    WHEN 1 THEN 'Elevated API error rates'
    WHEN 2 THEN 'Website unavailable'
    ELSE 'Delayed email delivery'
  END,
  'Example incident number ' || i || '.',
  CASE i % 4 WHEN 0 THEN 'maintenance' WHEN 2 THEN 'major_outage' ELSE 'minor_outage' END,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (i * 9 + 7) || ' days'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (i * 9 + 7) || ' days', '+90 minutes'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (i * 9 + 7) || ' days'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (i * 9 + 7) || ' days', '+90 minutes')
FROM n;

INSERT INTO incident_services (incident_id, service_id)
SELECT id, printf('00000000-0000-4000-8000-%012d', (CAST(substr(id, -2) AS INTEGER) % 3) + 1)
FROM incidents WHERE id LIKE '00000000-0000-4000-b000-%';

-- Make the next request re-render the whole site from this data.
DELETE FROM publish_queue;
DELETE FROM site_state;
