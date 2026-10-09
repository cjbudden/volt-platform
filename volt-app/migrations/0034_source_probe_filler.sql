-- ===========================================================================
--  WHAT EACH SOURCE IS, AND THE LOOP BUILT TO MATCH IT.
--
--  stream_inputs.probe: the source's measured qualities (codec, H.264 profile and
--  level, width, height, fps, bitrate, audio sample rate/channels/bitrate), taken
--  when the source is added or changed. Push sources (SRT/RTMP) cannot be probed
--  until something is pushed; their row records that instead.
--
--  channels/events.filler_build: the fallback loop (or slate) pre-rendered to the
--  channel's ladder from those probes and packaged once, so that on a loss the
--  delivered playlists can splice it in (volt-encoder/bin/playout.py) without
--  encoding anything at failover time. {status, hash, dir, renditions, error, ...}
-- ===========================================================================
ALTER TABLE stream_inputs ADD COLUMN IF NOT EXISTS probe     JSONB;
ALTER TABLE stream_inputs ADD COLUMN IF NOT EXISTS probed_at TIMESTAMPTZ;
ALTER TABLE channels      ADD COLUMN IF NOT EXISTS filler_build JSONB;
ALTER TABLE events        ADD COLUMN IF NOT EXISTS filler_build JSONB;
