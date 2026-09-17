# @volt/ingest-core

The upload and ingest framework behind Volt, as a library with no database
and no UI. Point any tus client at it, or embed the pure parts in your own
server, and you get the same rules ladder, naming, duplicate handling,
metadata extraction, sidecars and webhooks Volt uses.

```
npm install @volt/ingest-core
```

Optional peers: `express` (for the tus router), `@aws-sdk/client-s3` and
`@smithy/signature-v4` (for the S3 destination and presigned URLs). The
pure modules need nothing.

## What is in it

| Module | What it does |
| --- | --- |
| `sanitise`, `applyNaming` | Safe file names (NFKD, `[A-Za-z0-9._-]`, length cap, reserved names) and the naming and structure modes: honour, guid, guid_prefixed, template; flat, honour, minimal, template. |
| `resolveIngest`, `matches` | The rules ladder: account < type < source < item, first match by ordinal within a rung, per-field inheritance over `BASELINE`, with `deferred` when a rule needs facts (duration, real type) not yet known. |
| `findMatch`, `decideDuplicate` | Content, name-and-size, name and size matches; skip, replace, version, rename or ask. |
| `sniff` | Real container from the first 256 bytes, sixteen signatures, no dependency. |
| `readId3v2` | ID3v2.2 to 2.4 text frames: title, artist, album, track, year, genre, composer, comment, cover present. |
| `extract`, `candidates`, `mergeMetadata`, `missingRequired` | ffprobe plus tags plus file facts, mapped into a content type's fields; operator over rule over extracted. |
| `buildPayload`, `toXml`, `signWebhook`, `sidecarKey` | One payload for the sidecar, the webhook and callbacks; HMAC `t=<ts>,v1=<hex>`. |
| `createTusRouter`, `MemoryTusStore` | tus 1.0.0 as Express middleware over a store interface: creation, creation-with-upload, expiration, termination, checksum. |
| `LocalDestination`, `S3Destination`, `MemoryS3`, `realS3` | Where objects and sidecars land; S3 multipart with parts in flight and Transfer Acceleration. |
| `sources.*` | URL, Dropbox, OneDrive, Google Drive adapters and the parallel range fetcher for cloud to cloud. |
| `providers.*` | Aspera, MASV, Signiant and S3 acceleration as `TransferProvider` plugins. |
| `INGEST_EVENTS` | The one list of event names for clients, SSE and webhooks. |

## Sixty second example

```ts
import express from 'express';
import { createTusRouter, MemoryTusStore, resolveIngest, applyNaming, extract, candidates, mergeMetadata, buildPayload } from '@volt/ingest-core';

const rules = [
  { id: 'acc', rung: 'account', ordinal: 0, name: 'default', then: { naming: 'guid', duplicate: 'ask' } },
  { id: 'mxf', rung: 'source', scopeId: 'tus', ordinal: 0, name: 'long mxf is a match', when: { extensions: ['mxf'], minDurationSec: 1200 }, then: { contentTypeId: 'sport' } },
];

const app = express();
app.use('/tus', createTusRouter({
  store: new MemoryTusStore('/tmp/tus'),
  basePath: '/tus',
  authorise: async (req) => ({ user: req.get('authorization') }),
  onComplete: async (info, who, sha256) => {
    const path = `/tmp/tus/${info.id}.tus`;
    const x = await extract(path, { originalName: info.metadata.filename, bytes: info.length, sha256 });
    const facts = { name: info.metadata.filename, bytes: info.length, mime: x.type.mime, kind: x.type.kind, durationSec: x.probe?.durationSec ?? null };
    const r = resolveIngest(rules, facts);
    const naming = applyNaming(r.settings, { originalName: facts.name, accountId: 'me', kind: x.type.kind });
    const merged = mergeMetadata(myTypeFields(r.settings.contentTypeId), candidates(x), null, JSON.parse(info.metadata.metadata ?? '{}'));
    const payload = buildPayload({ event: 'ingested', account: 'me', assetId: null, kind: x.type.kind, contentTypeId: r.settings.contentTypeId, title: merged.metadata.name ?? facts.name,
      naming, store: 'local', bytes: info.length, sha256, source: 'tus', resolved: r, duplicate: null, metadata: merged.metadata, metadataSources: merged.sources, extracted: x, unmapped: merged.unmapped });
    // move the file to naming.key, write the sidecar, POST the payload: your call
  },
}));
```

Any tus client can now upload: `tus-js-client`, Uppy's Tus plugin, TUSKit
(iOS), tus-android-client, tus-py. `Upload-Metadata` keys the framework
reads: `filename`, `filetype`, `relativePath`, `schemaId`, `source`,
`metadata` (a JSON string of field values).

## Where the source lives

The modules are maintained in Volt (`volt-app/src/services/ingest`), where
the tests run against real files and real HTTP (`volt-app/test/ingest.sh`).
`npm run sync` copies them here and patches the two imports that reach
outside the core; `npm run build` does that and compiles. Do not edit
`src/` in this package directly.
