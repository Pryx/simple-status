-- Deletes all data, keeping the tables: services, incidents, updates, the activity
-- log and the publishing state. Then the next cron run (or request, locally) publishes
-- an empty site. See README, "Backups and starting over".
DELETE FROM incident_updates;
DELETE FROM incident_services;
DELETE FROM incidents;
DELETE FROM services;
DELETE FROM activity;
DELETE FROM publish_queue;
DELETE FROM site_state;
