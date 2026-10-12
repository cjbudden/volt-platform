// ============================================================================
//  JOB HANDLER — qc.run
//
//  QC decodes the whole clip, so it belongs on the queue rather than in a
//  request: a ten-minute clip is a ten-second job, and a reviewer should not be
//  watching a spinner for it.
//
//  Queued automatically when an extraction finishes, so every clip arrives in
//  the review queue with its findings already attached. A reviewer opening a
//  clip and seeing "not checked yet" is a reviewer who approves it unchecked.
// ============================================================================
import { one } from '../../../db';
import { runQc } from '../../qc';
import { PermanentError, registerHandler, type JobContext } from '../worker';
import { fireHook } from '../../workflows/hooks';

export interface QcRunPayload {
  vodAssetId: string;
  /** Override the file to measure. Used by tests and by a re-run against a
   *  specific rendition. */
  path?: string;
}

export const QC_RUN = 'qc.run';

export async function handleQcRun(ctx: JobContext): Promise<Record<string, unknown>> {
  const p = ctx.job.payload as QcRunPayload;
  if (!p?.vodAssetId) throw new PermanentError('qc.run payload is missing vodAssetId', 'bad_payload');

  const asset = await one<any>(`SELECT id FROM vod_assets WHERE id = $1`, [p.vodAssetId]);
  if (!asset) throw new PermanentError(`vod asset ${p.vodAssetId} no longer exists`, 'asset_gone');

  await ctx.progress(5, 'measuring the clip');
  const result = await runQc(p.vodAssetId, { path: p.path });
  fireHook('qc.completed', 'vod_asset', p.vodAssetId, { state: result.state, findings: result.findings.length });
  await ctx.progress(100, `${result.state}: ${result.findings.length} finding(s)`);

  return {
    state: result.state,
    findings: result.findings.length,
    errors: result.findings.filter((f) => f.severity === 'error').length,
    warnings: result.findings.filter((f) => f.severity === 'warning').length,
    skipped: result.skipped.length,
  };
}

export function registerQcHandlers(): void {
  registerHandler(QC_RUN, handleQcRun);
}
