-- Calendar events follow the same retry ladder as email notifications
-- (architecture doc §7). Add attempt tracking + due-time scheduling.
ALTER TABLE calendar_events
  ADD COLUMN attempts        INT NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX idx_calendar_due ON calendar_events (next_attempt_at)
  WHERE sync_status IN ('pending', 'deleting');
