# Forms & field management — design decision

_Decided 6 Aug. Question raised: when the source protocol changes the example/format
must change to suit it — do we hard-code these in component code or store form
definitions in the DB? Should we build a general form builder + assign forms to app
elements (for i18n labels and custom fields)?_

## Decision: hybrid, right-tool-per-concern — NOT a general form builder

A runtime, DB-defined form engine over the **core** product forms (create channel,
settings, profiles) is rejected as over-abstraction. Those forms carry real
conditional logic (transcode vs package branching, source-gated go-live, the ≤4h
DVR rule) and are bound to the API's zod contracts. A generic engine would drop type
safety, split validation across two places, and make every change slower. The
opinionated surface is a feature.

Three separate concerns, three tools:

### 1. Protocol-dependent source fields → descriptor registry (code, served by API)
The ingest-protocol set is bounded by what the encoder can actually ingest
(`ingest_protocol` enum: srt|rtmp|rtmps|hls|dash|ndi|st2110) — a tenant can't invent
one, so there is no per-tenant customization need and therefore no DB need. A single
typed registry describes each protocol (label, urlLabel, placeholder, example, hint,
whether a stream-key field shows, push|pull, url pattern). It drives the form's
example/placeholder/fields AND server-side validation, so they can't disagree.
- Source of truth: `volt-app/src/services/ingestProtocols.ts`.
- Served at `GET /api/ingest-protocols`; the app fetches + caches it
  (`volt-web/src/protocols.tsx`, `useProtocols()` + `<SourceInput>`), with a small
  built-in fallback so the form works if the fetch is momentarily down.
- "Data-driven" by descriptor, versioned in code + type-checked — not a DB form
  builder. Can move to a DB table later IF tenant-editable protocols ever exist.

### 2. Labels in other languages → i18n message catalogs (NOT data-driven forms)
Translation is orthogonal to form structure. Solve with a message-catalog layer
(keys → en/ms/zh/ta), covering the whole app, not just forms. A form builder is the
wrong axis for localization. (Planned, not yet built.)

### 3. Genuinely custom / tenant-defined fields → `metadata_schemas` (already built)
The platform already has a data-driven custom-field engine: `metadata_schemas`
(named, typed fields — string/text/number/boolean/date/enum/url/tags/reference —
with labels, required, options, inheritance, bound to channel/event/vod, validated
server-side by `validateEntityMetadata`). This IS the "form builder" for the part
that genuinely needs it. Missing piece is only the **app-side dynamic renderer** that
maps a schema's fields to inputs. That is a UI job on an existing engine, not new
architecture.

## Phased plan
1. **[done]** Ingest-protocol descriptor registry + `GET /api/ingest-protocols`;
   `<SourceInput>` wired into the create form (transcode primary/backup, package
   rows + single fallback) and the settings drawer.
2. Typed "field descriptor" helper so heavily-conditional forms (create channel) are
   declared as a spec the component maps over — middle ground between hand-written
   JSX and a runtime engine. Still typed, still in code.
3. i18n message-catalog layer; extract existing strings first.
4. Dynamic renderer for `metadata_schemas` → custom fields on channels/events/VOD.
5. **Explicitly not:** a drag-and-drop form builder owning the core forms, unless a
   concrete requirement forces it (e.g. a reseller must fully re-skin the flow).

## Removal / change discipline
Tracked in the feature tracker; nothing gets dropped without a formal confirmation
(then struck from both the tracker and VOLT_BUILD_STATUS.md).
