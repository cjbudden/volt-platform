# Volt desktop agent

A small Node program that watches folders on a workstation or a server and
feeds Volt. It recognises Google Drive, OneDrive and Dropbox sync roots and,
when the account is linked in Volt, asks Volt to fetch those files cloud to
cloud instead of sending them through this machine's connection. Everything
else is uploaded with tus, resumable, carrying the relative path and the
provenance so Volt's ingest rules see the same facts a folder pick would.

```
npm install && npm run build
node dist/cli.js agent.json
```

`agent.json`:

```json
{
  "server": "https://volt.example.com",
  "token": "sk_live_...",
  "folders": [
    { "path": "/Users/me/Library/CloudStorage/Dropbox-Team/Shoots", "source": "agent", "preferCloud": true },
    { "path": "/Volumes/Ingest/drop", "source": "agent", "schemaId": null }
  ],
  "quietMs": 10000,
  "intervalMs": 30000
}
```

A file is handled once it has been unchanged for `quietMs`. State lives in
`~/.volt-agent/state.json`, so a restart does not re-upload. Cloud-only
placeholders (Files On Demand, Drive streaming, Dropbox online-only) are
never read from disk; if the account is not linked in Volt they are skipped
with a message rather than downloaded and re-uploaded.

## On a Hybrid Site

```
volt-agent site enrol https://volt.example.com vsenrol_... [state.json]
volt-agent site run [state.json]
```

The state file (default `~/.volt-agent/site.json`) holds the host's
credential and is kept readable by its owner only. With Mirror and Archive the
agent also copies media to the site's storage targets: folders, NAS shares and
S3-compatible stores (MinIO and similar).

**Keys of S3-compatible stores stay on this host.** Volt only knows the name
of the keys (`credentialRef` on the target). Put them in `archive-keys.json`
beside the state file (or the file `VOLT_ARCHIVE_KEYS` names), mode 600; a key
file others can read is refused:

```json
{ "nas-minio": { "accessKeyId": "...", "secretAccessKey": "..." } }
```

or in the environment: `VOLT_ARCHIVE_KEY_NAS_MINIO_ID` and
`VOLT_ARCHIVE_KEY_NAS_MINIO_SECRET`. They are read for every copy, so rotated
keys take effect at once.

**Encoding at the site** (Hybrid Sites, Encode at site). The agent leases the
site's probe and encode jobs and runs `vod_encoder.py` with the settings the
cloud planned; only the packaged output is uploaded, and the cloud checks it
before the asset is ready. Point the agent at the pinned encoder image:

```
VOLT_ENCODER_IMAGE=volt-encoder:<version> volt-agent site run
```

It runs under Docker with the source folder mounted read only and no network;
jobs planned for NVENC go only to hosts with an NVIDIA GPU (and get
`--gpus all`). Without Docker, `VOLT_ENCODER_BIN=<volt-encoder/bin>` runs the
script with this host's own python3, ffmpeg and packager. Each attempt works in
`~/.volt-agent/encode` (or `VOLT_SITE_SCRATCH`), removed when the job ends.
