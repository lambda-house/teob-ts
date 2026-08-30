-- TEOB Journal Schema for PostgreSQL
-- Compatible with Pekko R2DBC persistence plugin

CREATE TABLE IF NOT EXISTS journal (
    persistence_id VARCHAR(255) NOT NULL,
    sequence_nr BIGINT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    event BYTEA NOT NULL,
    event_manifest VARCHAR(255) NOT NULL,
    serializer_id INTEGER NOT NULL DEFAULT 0,
    writer_uuid VARCHAR(255) NOT NULL DEFAULT '',
    tags TEXT DEFAULT '',
    ordering BIGSERIAL,
    PRIMARY KEY (persistence_id, sequence_nr)
);

CREATE INDEX IF NOT EXISTS journal_ordering_idx ON journal (ordering);
CREATE INDEX IF NOT EXISTS journal_persistence_id_idx ON journal (persistence_id);
CREATE INDEX IF NOT EXISTS journal_persistence_id_timestamp_idx ON journal (persistence_id, timestamp);

CREATE TABLE IF NOT EXISTS snapshot (
    persistence_id VARCHAR(255) NOT NULL,
    sequence_nr BIGINT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    snapshot BYTEA NOT NULL,
    snapshot_manifest VARCHAR(255) NOT NULL,
    serializer_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (persistence_id, sequence_nr)
);

CREATE INDEX IF NOT EXISTS snapshot_persistence_id_sequence_nr_idx ON snapshot (persistence_id, sequence_nr DESC);

-- LISTEN/NOTIFY trigger for real-time event streaming

CREATE OR REPLACE FUNCTION notify_journal_event()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify('journal_events', NEW.ordering::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_notify_trigger ON journal;
CREATE TRIGGER journal_notify_trigger
    AFTER INSERT ON journal
    FOR EACH ROW
    EXECUTE FUNCTION notify_journal_event();
