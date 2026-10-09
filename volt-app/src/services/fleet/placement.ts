// ============================================================================
//  WHERE A TASK ACTUALLY LANDED.
//
//  The distinction this file exists to enforce: a PLACEMENT is an observation,
//  and the thing it replaces was a guess.
//
//  `instances.instance_type` has been written exactly once in this codebase,
//  for the captions task, from recommendInstance() — which is sizing ADVICE
//  computed from the output profile before anything was launched. It says what
//  we would like AWS to give us. It has never said what AWS gave us, and on a
//  cluster with mixed capacity those two routinely differ.
//
//  Nothing here is computed. Every field is either reported by the provider or
//  left null, and null means "we could not ask", never "none" and never zero.
//  A caller that cannot distinguish those two will draw an idle CPU for a host
//  it simply failed to reach, which is the worst possible failure mode for a
//  capacity screen: it looks like good news.
// ============================================================================

/**
 * The three kinds of machine, and why they cannot be collapsed into one.
 *
 *   ec2      Real and SHARED. Several tasks land on it, so host CPU is a fact
 *            about the machine and answers "do I need more capacity". This is
 *            the only kind for which "streams per server" is an observation.
 *
 *   fargate  A microVM carrying exactly one task. There is no host to read and
 *            no sharing to observe: tasks-per-host is 1 because the purchasing
 *            model says so, not because we counted. Reporting it as though it
 *            were measured would invite someone to "consolidate" a fleet that
 *            has no consolidation available to it.
 *
 *   local    The box the control plane is itself running on, under the local
 *            or docker launcher. Shared, measurable, and the only kind where
 *            the metrics come from the same kernel as the reader.
 */
export type HostKind = 'ec2' | 'fargate' | 'local';

/** What kind of WORK a task is, which is not the same as its redundancy role. */
export type TaskKind = 'transcode' | 'package_only' | 'radio' | 'captions' | 'thumbnailer';

export interface Placement {
  hostKind: HostKind;
  /**
   * The provider's own stable identifier for the machine, and the key the host
   * registry upserts on. i-0abc… for EC2, the task arn for Fargate (where the
   * task IS the machine), a hostname for local. Stability across control-plane
   * restarts is the whole requirement: a registry keyed on anything we
   * generate would grow a new host row every boot.
   */
  externalId: string;
  containerInstanceArn?: string | null;
  instanceType?: string | null;
  region?: string | null;
  availabilityZone?: string | null;
  lifecycle?: 'spot' | 'on_demand' | null;
  capacityProvider?: string | null;
  /** Host totals, where the provider reports them. */
  vcpus?: number | null;
  memoryMib?: number | null;
  /** What THIS task reserved, which is a different number from the host total. */
  cpuUnits?: number | null;
  taskMemoryMib?: number | null;
}

/** Parse the ECS `ecs.instance-type` style attribute list into a lookup. */
export function attrMap(attrs: Array<{ name?: string; value?: string }> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of attrs ?? []) if (a?.name) out[a.name] = a.value ?? '';
  return out;
}

/**
 * An AZ implies its region by construction (ap-southeast-1a -> ap-southeast-1),
 * so a placement that reports one need not also report the other. Returns null
 * rather than guessing when the string is not shaped like an AZ, because a
 * wrong region silently sends every CloudWatch query to an empty namespace and
 * the result looks exactly like a quiet fleet.
 */
export function regionFromAz(az: string | null | undefined): string | null {
  if (!az) return null;
  const m = /^([a-z]{2}(?:-[a-z]+)+-\d+)[a-z]$/.exec(az.trim());
  return m ? m[1] : null;
}

/**
 * Which capacity a task is on, from the capacity provider name.
 *
 * Deliberately conservative: anything not recognisably spot is reported as
 * on-demand, because the two directions of error are not symmetric. Calling a
 * spot task on-demand overstates the bill, which someone notices and corrects.
 * Calling an on-demand task spot understates it, which nobody notices until
 * the invoice arrives.
 */
export function lifecycleFromProvider(name: string | null | undefined): 'spot' | 'on_demand' {
  return /spot/i.test(name ?? '') ? 'spot' : 'on_demand';
}
