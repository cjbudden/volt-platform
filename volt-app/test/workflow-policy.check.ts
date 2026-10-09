// ============================================================================
//  Workflow policy: the resolution chain, and what a share page is allowed to
//  offer. Pure logic, no database.
//
//    npx tsx test/workflow-policy.check.ts
// ============================================================================
import assert from 'node:assert';
import {
  DEFAULT_POLICY, resolvePolicy, shareActions, deploymentPolicyFromEnv,
  type ShareContext,
} from '../src/services/workflowPolicy';

let n = 0;
const ok = (label: string, fn: () => void) => { fn(); n++; console.log(`  ok  ${label}`); };
const act = (ctx: Partial<ShareContext> = {}) => shareActions({
  purpose: 'review',
  policy: resolvePolicy(),
  link: { allowHiRes: true, allowMetadata: true },
  qcState: 'pass', reviewState: 'in_review',
  identified: true, pendingNotes: 1, approvals: 0,
  ...ctx,
} as ShareContext);
const find = (as: any[], id: string) => as.find((a) => a.id === id);

console.log('the chain');
ok('nothing set gives the built-in defaults', () => {
  assert.deepEqual(resolvePolicy(), DEFAULT_POLICY);
});
ok('the deployment overrides the defaults', () => {
  assert.equal(resolvePolicy({ deployment: { review: { qcGate: 'hard' } } }).review.qcGate, 'hard');
});
ok('an account overrides the deployment', () => {
  const p = resolvePolicy({ deployment: { review: { qcGate: 'hard' } }, account: { review: { qcGate: 'soft' } } });
  assert.equal(p.review.qcGate, 'soft');
});
ok('a link overrides the account', () => {
  const p = resolvePolicy({ account: { share: { download: 'never' } }, link: { share: { download: 'optional' } } });
  assert.equal(p.share.download, 'optional');
});
ok('a rung only overrides what it sets', () => {
  // The bug this guards: a link that says nothing about PINs must not reset the
  // account's PIN rule to the default on its way past.
  const p = resolvePolicy({
    account: { share: { pin: 'required', download: 'never' } },
    link: { share: { download: 'optional' } },
  });
  assert.equal(p.share.pin, 'required');
  assert.equal(p.share.download, 'optional');
});
ok('an absent env var is not an override', () => {
  const patch = deploymentPolicyFromEnv({ WORKFLOW_REVIEW_QC_GATE: 'hard' });
  assert.equal(patch.review!.qcGate, 'hard');
  assert.equal(patch.review!.approvalsRequired, undefined);
  assert.equal(resolvePolicy({ deployment: patch }).review.approvalsRequired, 1);
});
ok('an env var with a value we do not recognise is ignored, not crashed on', () => {
  const patch = deploymentPolicyFromEnv({ WORKFLOW_REVIEW_QC_GATE: 'yes-please' });
  assert.equal(patch.review!.qcGate, undefined);
  assert.equal(resolvePolicy({ deployment: patch }).review.qcGate, 'soft');
});

console.log('what a preview link offers');
ok('no comment or decision on a preview', () => {
  const as = act({ purpose: 'preview' });
  assert.equal(find(as, 'comment'), undefined);
  assert.equal(find(as, 'approve'), undefined);
  assert.ok(find(as, 'watch'));
});
ok('policy can withdraw downloads the link granted', () => {
  const as = act({ purpose: 'preview', policy: resolvePolicy({ deployment: { share: { download: 'never' } } }) });
  assert.equal(find(as, 'download_hires'), undefined);
});
ok('but policy alone does not grant what the link withheld', () => {
  const as = act({ purpose: 'preview', link: { allowHiRes: false, allowMetadata: false } });
  assert.equal(find(as, 'download_hires'), undefined);
});

console.log('what a review link offers');
ok('an unidentified viewer can do nothing but watch, and is told why', () => {
  const as = act({ identified: false });
  assert.equal(find(as, 'comment').enabled, false);
  assert.equal(find(as, 'approve').enabled, false);
  assert.match(find(as, 'approve').reason, /name/i);
});
ok('verified-email policy changes the wording of the same block', () => {
  const as = act({ identified: false, policy: resolvePolicy({ deployment: { review: { identify: 'verified-email' } } }) });
  assert.match(find(as, 'comment').reason, /email/i);
});
ok('changes cannot be requested with no note when the policy says so', () => {
  assert.equal(find(act({ pendingNotes: 0 }), 'request_changes').enabled, false);
  assert.equal(find(act({ pendingNotes: 1 }), 'request_changes').enabled, true);
});
ok('turning that policy off allows a bare rejection', () => {
  const as = act({ pendingNotes: 0, policy: resolvePolicy({ deployment: { review: { requireNoteOnChanges: false } } }) });
  assert.equal(find(as, 'request_changes').enabled, true);
});

console.log('the QC gate');
ok('soft gate: approving over findings is allowed, and flagged as an override', () => {
  const a = find(act({ qcState: 'warnings' }), 'approve');
  assert.equal(a.enabled, true);
  assert.equal(a.override, true);
  assert.match(a.reason, /recorded/i);
});
ok('hard gate: it is refused, with the reason on the control', () => {
  const a = find(act({ qcState: 'failed', policy: resolvePolicy({ deployment: { review: { qcGate: 'hard' } } }) }), 'approve');
  assert.equal(a.enabled, false);
  assert.match(a.reason, /requires QC to pass/i);
});
ok('a clean QC run is never an override', () => {
  assert.equal(find(act({ qcState: 'pass' }), 'approve').override, undefined);
});

console.log('multi-approval and closure');
ok('the control says how many approvals are still needed', () => {
  const as = act({ approvals: 0, policy: resolvePolicy({ deployment: { review: { approvalsRequired: 2 } } }) });
  assert.match(find(as, 'approve').label, /2 approvals needed/);
});
ok('a closed review offers no decision, and no stale override warning', () => {
  const as = act({ reviewState: 'approved', qcState: 'warnings' });
  assert.equal(find(as, 'approve').enabled, false);
  assert.equal(find(as, 'approve').override, undefined);
  assert.match(find(as, 'approve').reason, /already closed/i);
});
ok('watching survives every policy', () => {
  assert.ok(find(act({ reviewState: 'rejected', identified: false }), 'watch').enabled);
});

console.log(`\n${n}/${n} assertions passed.`);
