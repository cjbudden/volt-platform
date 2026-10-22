/**
 * ONBOARDING (public, no session): the pages a welcome or reset email opens.
 * See services/onboarding.ts for the design and docs/ONBOARDING.md.
 *
 *   POST /api/onboarding/link      {token}                   who the link is for (changes nothing)
 *   POST /api/onboarding/code      {token}                   email a 6-digit code to that address
 *   POST /api/onboarding/verify    {token, code}             -> {setupToken} (15 minutes)
 *   POST /api/onboarding/complete  {setupToken, password, displayName?, accountName? (founder only)}
 *                                  -> a session, or a two-step sign-in step when the account requires one
 *   POST /api/onboarding/forgot    {email}                   always 202; emails a reset link if there is an account
 *
 * The token travels in the request BODY, never the query string, so it stays
 * out of access logs just as the URL fragment keeps it out of the page request.
 */
import { Router } from 'express';
import { z } from 'zod';
import { one } from '../db';
import { asyncHandler } from '../util/http';
import { limit } from '../scale/ratelimit';
import { writeAudit } from '../services/audit';
import { loadPrincipal, challengeResponse } from '../auth/identity';
import { issueAdminSession } from '../auth/routes';
import { describeLink, sendLinkCode, verifyLinkCode, completeLink, sendReset, sendInvite, passwordProblem } from '../services/onboarding';

export const onboardingRouter = Router();

const tokenBody = z.object({ token: z.string().min(1).max(200) });

const perIp = (req: any) => limit(`onboard-ip:${req.ip}`, 60, 900, 'Too many attempts from this network. Wait a few minutes and try again.');

onboardingRouter.post('/link', asyncHandler(async (req, res) => {
  await perIp(req);
  const { token } = tokenBody.parse(req.body ?? {});
  res.set('Cache-Control', 'no-store');
  res.json(await describeLink(token));
}));

onboardingRouter.post('/code', asyncHandler(async (req, res) => {
  await perIp(req);
  const { token } = tokenBody.parse(req.body ?? {});
  res.json(await sendLinkCode(token));
}));

onboardingRouter.post('/verify', asyncHandler(async (req, res) => {
  await perIp(req);
  const b = tokenBody.extend({ code: z.string().min(4).max(12) }).parse(req.body ?? {});
  res.set('Cache-Control', 'no-store');
  res.json(await verifyLinkCode(b.token, b.code));
}));

/** The rules, so the page can check as the person types (the server checks again). */
onboardingRouter.post('/password-check', asyncHandler(async (req, res) => {
  const b = z.object({ password: z.string().max(300), email: z.string().max(320).optional() }).parse(req.body ?? {});
  res.json({ ok: !passwordProblem(b.password, b.email), problem: passwordProblem(b.password, b.email) });
}));

onboardingRouter.post('/complete', asyncHandler(async (req, res) => {
  await perIp(req);
  const b = z.object({ setupToken: z.string().min(10).max(2000), password: z.string().max(300), displayName: z.string().max(120).nullable().optional(),
    accountName: z.string().max(160).nullable().optional() }).parse(req.body ?? {});
  const done = await completeLink(b.setupToken, b.password, b.displayName ?? null, b.accountName ?? null);
  await writeAudit(null, {
    accountId: done.accountId, userId: done.userId, label: 'security', action: 'update', entityType: 'user', entityId: done.userId,
    snapshot: { [done.kind === 'invite' ? 'invite' : 'password']: done.kind === 'invite' ? 'accepted' : 'reset by email' },
  }).catch(() => {});
  // Signed in straight away, unless the account requires a second step: then
  // the same challenge the sign-in page uses (it enrols one if they have none).
  const a = await one<any>(`SELECT require_admin_mfa FROM accounts WHERE id=$1`, [done.accountId]);
  const p = await loadPrincipal('user', done.userId);
  const step = p ? await challengeResponse(p, { required: !!a?.require_admin_mfa }) : null;
  // A founder's next job is their team: the console opens Users & Roles.
  const next = done.founder ? 'invite_team' : null;
  if (step) return res.json({ ...step, email: step.email ?? null, account: { email: done.email }, next });
  res.json({ ...(await issueAdminSession(done.userId, ['pwd'])), account: { email: done.email }, next });
}));

onboardingRouter.post('/forgot', asyncHandler(async (req, res) => {
  const b = z.object({ email: z.string().email().max(320) }).parse(req.body ?? {});
  const email = b.email.trim().toLowerCase();
  await limit(`forgot-ip:${req.ip}`, 20, 3600, 'Too many requests. Wait a while and try again.');
  // Per address the limit is silent: answering 429 for one address and 202
  // for another would say which addresses are being used.
  let devLink: string | undefined;
  try {
    await limit(`forgot:${email}`, 5, 3600);
    const u = await one<any>(`SELECT u.id, u.status, a.status AS account_status FROM users u JOIN accounts a ON a.id=u.account_id WHERE u.email=$1`, [email]);
    if (u && u.account_status !== 'suspended') {
      if (u.status === 'active') devLink = (await sendReset(u.id)).devLink;
      // Never finished their invite: a fresh welcome link does the same job.
      else if (u.status === 'invited') devLink = (await sendInvite(u.id)).devLink;
    }
  } catch (e: any) {
    if (e?.code !== 'rate_limited') console.error('[onboarding] forgot password', e?.message);
  }
  res.status(202).json({ ok: true, message: 'If that address has an account, a reset link is on its way.', ...(devLink ? { devLink } : {}) });
}));
