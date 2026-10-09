# Requirements: per-stream operating reports

**Status: specified, not built.** One report per channel, station and event,
covering every time it ran, how long for, how long it was on air, and what the
audience did.

**Read this part first.** Of the four figures asked for, two can be produced from
what the system already stores, one is **not recorded anywhere for channels or
events**, and one is exact only inside a retention window and must never be drawn
as zero outside it. The gap is small and specific, and it is a table.

| Asked for | Source today | Status |
|---|---|---|
| Start and end time, duration, per run | `instances` and `usage_accruals` | **Available** |
| Total hours run | `usage_accruals.seconds` | **Available and durable** |
| **Total hours on air** | nothing for channels or events; a clearable log for radio | **Not recorded** |
| Peak concurrent viewers | `play_sessions` sweep, then `analytics_rollups` | **Exact, then daily only, then gone** |

---

## 1. Runs: available, and there are two sources

**`instances`** carries one row per encoder task with `launched_at`,
`terminated_at`, `task_kind`, `lifecycle`, `instance_type` and `host_id`. It is
the natural answer to "when did it run", and it is the one to use for anything
recent or live.

**It is not durable.** Migration 0013 cascades instance rows away with the
channel, so deleting a station takes its run history with it.

**`usage_accruals` is the durable ledger**, and it was built with exactly this
problem in mind. It carries `stream_id` and `stream_name` a second time with no
foreign key, precisely so that a billing record outlives the thing it bills for.
A run is then `GROUP BY instance_id` giving `min(from_at)`, `max(to_at)`,
`sum(seconds)`, and it is correct across control-plane restarts because the meter
advances a mark rather than measuring from `now()`.

**Requirement: the report reads runs from the accrual ledger, and joins to
`instances` only to enrich a run that still has one.** A report that disappears
when a channel is deleted is not a report.

One caveat to state in the UI rather than discover later: **accruals only exist
where the meter has run**. On a development machine with the mock launcher, the
run history will be thin or empty, and that is not a fault.

---

## 2. Hours on air: the gap, and it is total for two of the three kinds

"Running" and "on air" are different, and the difference is the point of the
second number. A station can run for six hours and be publicly delivering for
two. `channels.on_air` is a **boolean with no history**: it says what is true
now and nothing about how it got there.

What is recorded when it changes:

| Path | Code | Trace left |
|---|---|---|
| Radio goes on or off air | `modules/radio.ts` | a `channel.air` / `channel.off_air` **event** |
| Radio station stopped while on air | `modules/radio.ts` | a `channel.off_air` event |
| **Channel goes on or off air** | `modules/channels.ts`, `UPDATE channels SET on_air = $1` | **nothing** |
| **Channel taken off air on delete or stop** | `modules/channels.ts` | **nothing** |

So on-air time is **unavailable for channels and events**, and for radio it is
reconstructable only from `stream_events`, which nothing prunes today, which
means it will be pruned eventually, and which an operator can now clear from the
station page with one button. A metric that a Clear button can destroy is not a
metric.

### What is needed: one small ledger

Following the shape `usage_accruals` and `listener_sessions` already use, an
identity that is snapshotted and free of foreign keys so the record outlives the
thing it describes:

```sql
CREATE TABLE air_sessions (
  id           BIGSERIAL PRIMARY KEY,
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  stream_kind  TEXT NOT NULL,          -- channel | radio | event
  stream_id    UUID NOT NULL,          -- deliberately no FK
  stream_name  TEXT NOT NULL,          -- snapshot, so a rename does not rewrite history
  channel_id   UUID REFERENCES channels(id) ON DELETE SET NULL,
  event_id     UUID REFERENCES events(id) ON DELETE SET NULL,
  from_at      TIMESTAMPTZ NOT NULL,
  to_at        TIMESTAMPTZ,            -- NULL while still on air
  opened_by    TEXT,                   -- operator label, schedule, api
  closed_by    TEXT,
  close_reason TEXT                    -- operator | stream stopped | schedule | fault
);
```

**And one function that writes it, called from every path that flips the
boolean.** That is the actual requirement, not the table. There are at least four
places that set `on_air` today and they already disagree about whether to record
anything; adding a fifth consumer that has to remember is how this breaks again.
`setOnAir(kind, id, on, actor, reason)` owns the column and the ledger together,
and nothing else touches `channels.on_air`.

An open row with `to_at IS NULL` is a stream that is on air right now, so the
same table answers the live question and the historical one, and the reconciler
that already corrects a stale `status` should close any air session whose stream
is demonstrably not running.

---

## 3. Peak concurrent: exact, then daily, then absent

There are three sources and they degrade in that order.

- **`stream_concurrency`** is a current-value table, one row per asset, no
  history. It cannot contribute to a report at all.
- **`play_sessions`** carries `started_at`, `last_seen_at`, `ended_at` and
  `seconds_watched` per viewer. **Peak concurrent for any arbitrary window,
  including one run, is a sweep over those intervals.** This is exact and it is
  the only source that can produce a per-run peak.
- **`analytics_rollups`** carries `peak_concurrent` per scope **per day**, sealed
  and durable.

`play_sessions` is pruned per account after a raw window, and correctly: the
retention design recomputes, then seals, then prunes, and refuses to prune a day
whose rollup is not sealed. But the consequence for this report is unavoidable:

> **Once the raw window has passed, a per-run peak no longer exists and cannot be
> recovered.** The day's peak survives; the run's does not.

**Requirement: the report must distinguish "zero viewers" from "no longer
retained".** A run from four months ago showing `Peak 0` invites exactly one
conclusion, and it is the wrong one. Return `null` and render "not retained",
with the day's rollup peak offered instead where it exists. This is the same rule
`relayHealth` already follows for an unmeasured host, and the same one
`host_samples` follows by writing no row for a failed reading.

---

## 4. What else the report should carry

Ranked by how often somebody will ask for it.

### Reliability, which is what a client with an SLA wants

- **Availability**: on-air seconds over the period, and as a percentage of the
  scheduled window for an event, or of the period for a 24×7 channel. This is the
  number that goes in a contract, and the air ledger is what unblocks it.
- **Planned versus unplanned stops.** We already record a stop reason, and the
  difference between "the operator stopped it" and "the encoder exited rc=183" is
  the difference between a report that means something and a count of twelve.
- **Mean time to recovery**: the gap between an unplanned stop and the next run
  that stayed up. Derivable from the run ledger plus stop reasons.
- **Restart count and resume attempts per run**, which is how a crash loop shows
  up as a number rather than as a wall of log lines.
- **Time to first segment**: the encoder already knows its boot time, and "how
  long from Start to audio" is the number an operator feels.

### Audience

- **Total watch hours** and **average concurrent**, not only the peak. A peak of
  400 for ninety seconds and a steady 300 for two hours are different products.
- **When the peak happened.** A peak without a timestamp cannot be correlated
  with anything that caused it.
- **Unique viewers**, already computed at seal from the set rather than counted
  incrementally.
- **Breakdown by geography, device and app**, already carried on the rollup as
  JSONB.
- **MP3 listeners separately**, from `listener_sessions`, with measured bytes.
  Those are a different delivery path with a different cost and should not be
  averaged into the HLS numbers.

### Quality, which is the part a broadcaster notices and nobody else reports

- **Dead air and static time per run.** The radio monitor already classifies
  these with sustained thresholds and raises events. Time in dead air is a
  broadcast quality metric that a general video platform cannot produce.
- **Time with a degraded output.** We now record which outputs the encoder
  refused; a ledger of that gives "delivered all three outputs for 97% of
  airtime", which is a far more honest statement than "on air".
- **Input failover and filler time**, both already tracked in stream status.

### Cost, which ties the report to the thing you keep coming back to

- **Estimated cost per run**, from `usage_accruals.est_usd`, already
  effective-dated so correcting a rate does not rewrite last month.
- **Egress and relay cost** for the same window, from `relay_accruals`.
- **Recording produced**: hours captured, storage held, clips and VoD created.

---

## 5. Shape of the deliverable

- `GET /api/reports/stream/:id?from=&to=` returning the run list, the totals, the
  audience block and the quality block, each field nullable and each null
  meaning "not retained" rather than zero.
- The same report as **CSV**, because the first thing anyone does with an
  operating report is put it in a spreadsheet.
- A **period summary across all streams** for an account, which is the version a
  client actually opens monthly.
- Scoped by the existing tenant model. Cost fields visible to an account admin
  are their own spend; the platform's cost basis stays behind `requirePlatform`,
  as `RELAY.md` already sets out.

## 6. Acceptance criteria

1. A stream that ran three times shows three rows with start, end and duration,
   and the total equals the sum.
2. Deleting the channel does not delete the report.
3. Hours run and hours on air are different numbers, and a stream that ran
   without ever going on air reports run hours with zero air hours.
4. A run inside the raw window reports an exact peak; one outside it reports
   **not retained**, never zero, and offers the day's peak instead.
5. Renaming a stream does not rewrite the name on historical rows.
6. A stop caused by a fault and a stop caused by an operator are distinguishable
   in the report without reading a log.

## 7. Out of scope for the first release

- Per-programme reporting against the EPG. Valuable, and it needs the guide to be
  authoritative first.
- Real-time dashboards. This is a report over a finished period.
- Any attempt to reconstruct on-air history before the ledger exists. It is not
  there, and inventing it from the event log would produce a number nobody can
  defend.
