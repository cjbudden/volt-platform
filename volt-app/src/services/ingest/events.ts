// The one list of ingest event names, shared by the browser client, the SSE
// feed and the webhook `event` field. Adding a name here is the whole change.
export const INGEST_EVENTS = [
  'added', 'queued', 'started', 'progress', 'paused', 'resumed', 'restored', 'transferred',
  'verifying', 'verified', 'duplicate', 'duplicate_resolved', 'awaiting_metadata', 'metadata_set',
  'ingesting', 'ingested', 'failed', 'cancelled',
  'rule_matched', 'source_found', 'quarantined', 'sidecar_written', 'webhook_delivered', 'workflow_queued',
] as const;
export type IngestEvent = typeof INGEST_EVENTS[number];
