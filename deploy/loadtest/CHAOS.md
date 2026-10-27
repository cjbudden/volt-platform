# Chaos and scaling run sheet (Tier 3)

Break the Tier-2 staging deployment on purpose, one fault at a time, and check
that Volt comes back the way its design says. Build queue item 2.8. The
harness is `chaos.mjs` (the plans, run loop and judge are in `chaos-lib.mjs`,
checked by `volt-app/test/chaos-harness.check.ts`). Viewer load is the k6
script in this folder (`README.md`).

Every scenario has a dry run that calls nothing and prints the exact commands
a real run would send. Read it first.

```bash
node deploy/loadtest/chaos.mjs kill-encoder --dry-run --tf-outputs out.json --channel <id>
```

## 1. Before the first run

1. **The stack.** The Tier-2 staging stack applied from `deploy/terraform`
   with, in `terraform.tfvars`:
   - `enable_chaos_experiments = true` (the Fault Injection Service templates
     in `chaos.tf`; off by default, never on in production),
   - `control_plane_desired = 2` and, with the role split, `api_public_min = 2`,
     so a task runs in each zone,
   - `db_multi_az = true` if the zone run should also fail the database over.

   Then `terraform output -json > out.json`. The harness reads `ecs_cluster`,
   `control_plane_url`, `api_edge_domain`, `role_services`, `chaos_stack` and
   `chaos_experiment_templates` from it.
2. **AWS CLI** signed in to the staging account, allowed `ecs:StopTask`,
   `ecs:DescribeServices`, `fis:StartExperiment`, `fis:StopExperiment`,
   `fis:TagResource`, `ec2:DescribeInstances`, `ec2:StopInstances` and
   `rds:RebootDBInstance`.
3. **Volt.** An account key (`sk_live_...`, in `VOLT_KEY` or `--key`), and two
   or three test channels that are live, **on air**, have **auto connect** on
   and have been healthy once in this run (that arms auto connect). One of
   them with a backup source sending, one with only a filler (Loops & Fillers).
   For scale-out, a web app's publishable key (`VOLT_APP_KEY`) and k6.
4. **Safety.** A real run refuses unless `--confirm` names the stack
   (`chaos_stack.stack_name`, for example `volt-staging`), and refuses
   anything with `prod` in its name. Exit code 0 is a pass, 1 a failed
   expectation, 2 a run that could not start. `--out result.json` keeps every
   sample and the verdict.

Run them in this order; each one leaves the stack as it found it.

## 2. Kill an encoder task

```bash
node deploy/loadtest/chaos.mjs kill-encoder --tf-outputs out.json --confirm volt-staging --channel <id>
```

Stops the channel's ECS task, as a crash or an out-of-memory kill would.

| Expect | Within | Why that long |
|---|---|---|
| The control plane sees it is gone | 45 s | the orchestrator tick (30 s) reconciles streams with no running task |
| A new task on air, playlist advancing | 240 s (480 s with `--new-server`) | auto connect tries every 20 s; a task on a server with room starts in about a minute, a new server adds two or three |
| One replacement task | | five attempts, 20 s apart, then it gives up and says why |

If it fails: the channel page's diagnosis and `resume_last_error`; a give-up
is cleared by pressing Start.

## 3. Lose a source

```bash
node deploy/loadtest/chaos.mjs lose-source --tf-outputs out.json --confirm volt-staging --channel <id> \
  [--stop-source "<command that stops the primary feed>" --start-source "<command that restarts it>"] [--hold 60]
```

Without the two commands it asks you to stop and restart the primary feed by
hand. Run it once on the channel with a backup and once on the one with only
a filler.

| Expect | Within | Why |
|---|---|---|
| Active source moves off primary (backup, or filler) | 14 s | the selector calls a source lost after 3 s; the harness samples every 2 s |
| The public playlist never stands still | 12 s (three 4 s segments) | what a player's buffer rides over |
| Back on primary after it returns | 29 s | the selector waits for 10 s of healthy primary before failing back |

## 4. Interrupt a Spot server

```bash
node deploy/loadtest/chaos.mjs spot-interrupt --tf-outputs out.json --confirm volt-staging --channel <id> --channel <id>
```

FIS gives one running encoder server the two-minute Spot notice. ECS drains
it (`ECS_ENABLE_SPOT_INSTANCE_DRAINING`); encoder tasks are not ECS services,
so they stop with the server and auto connect relaunches them elsewhere. Pass
every channel that might be on that server.

| Expect | Within |
|---|---|
| Every channel on air again on another server | 600 s (the notice plus a new server) |
| One replacement task per channel | |

## 5. Scale out under viewer load

```bash
node deploy/loadtest/chaos.mjs scale-out --tf-outputs out.json --confirm volt-staging --channel <id> \
  --app-key pk_live_... --peak 2000 --ramp 120s --hold-load 300s
```

Runs `viewer-start.js` and samples api-public's desired and running tasks
every 2 s.

| Expect | |
|---|---|
| api-public runs more tasks at the peak than at the start | the request and CPU targets in `scaling_services.tf` |
| Play gate p95 at or under 300 ms | the k6 threshold |
| Failed requests at or under 1 % | the k6 threshold |

Raise `--peak` step by step (500, 1,000, 2,000, 5,000). Record per step the
peak starts a second, p95, task count and CPU; set `prewarm_starts_per_task`
to what one task held at about 60 % CPU. Above about 5,000 a second use
several k6 machines and tell AWS Support first.

## 6. Lose a zone (last)

```bash
node deploy/loadtest/chaos.mjs fail-az --tf-outputs out.json --confirm volt-staging --az <zone> \
  --channel <id> --channel <id> --channel <id>
```

Starts the zone's FIS template (the private subnet is cut off for
`chaos_fault_seconds`, 600 s, and restored by FIS itself), stops the ECS
servers in that zone, and fails a Multi-AZ database over to its standby.

**Pick a zone without the NAT gateway.** Staging has one NAT gateway (in the
first public subnet) to save money; losing its zone cuts every zone's way out.
That is a known single point, fixed in production by one NAT per zone.

| Expect | Within |
|---|---|
| The API is never unreachable for longer than | 120 s (with two control-plane tasks the load balancer drops the lost one in about 30 s) |
| Every channel on air with an advancing playlist | 480 s |

To end the cut early: `aws fis stop-experiment --id <experiment id>` (the run
prints the id). The Auto Scaling groups replace the stopped servers.

## 7. Results

Fill in one row per run and add the `--out` files beside this sheet.

| Date | Scenario | Channels | Result | Times seen | Notes |
|---|---|---|---|---|---|
| | | | | | |

## Cost of a full pass

About an hour of staging time. FIS bills per action-minute (about $0.10 a
minute: roughly $1 for the zone run, cents for the Spot one); the servers the
Auto Scaling groups start are the main cost, and they scale back in once
empty.
