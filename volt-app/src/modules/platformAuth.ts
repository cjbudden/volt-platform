/**
 * SaaS-admin two-step login (separate from tenant auth). Platform staff must
 * complete TOTP after the password step; first login enrols an authenticator.
 *   POST /api/platform/auth/login  {email,password}
 *     → platform user w/o secret : {enroll:true, secret, otpauthUri, mfaToken}
 *     → platform user w/ secret   : {mfa_required:true, mfaToken}
 *   POST /api/platform/auth/mfa    {mfaToken, code} → {accessToken}  (full session)
 * The mfaToken is a short-lived intermediate proving the password step passed.
 * In production the TOTP secret is stored in Secrets Manager (mfa_secret_ref =
 * the ARN); here mfa_secret_ref holds the base32 secret directly for the demo.
 */
import { Router } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { one } from '../db';
import { query } from '../db';
import { config } from '../config';
import { verifyPassword } from '../auth/password';
import { signAccess } from '../auth/jwt';
import { asyncHandler, unauthorized, badRequest } from '../util/http';
import { newSecret, verifyTotp } from '../services/totp';

export const platformAuthRouter = Router();

const loginSchema = z.object({ email: z.string().email(), password: z.string() });

platformAuthRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const u = await one<any>(
      `SELECT id, account_id, role, password_hash, status, platform_role, mfa_secret_ref, mfa_enabled, email
         FROM users WHERE email=$1`,
      [email]
    );
    if (!u || u.status !== 'active' || !(await verifyPassword(u.password_hash, password))) throw unauthorized('invalid credentials');
    if (!u.platform_role) throw unauthorized('not a platform user'); // SaaS-admin surface only
    const mfaToken = jwt.sign({ sub: u.id, typ: 'mfa' }, config.jwt.accessSecret, { expiresIn: 300 });
    if (!u.mfa_secret_ref) {
      // first login → enrol an authenticator
      const s = newSecret(u.email);
      await query(`UPDATE users SET mfa_secret_ref=$2, mfa_enabled=false WHERE id=$1`, [u.id, s.secret]);
      return res.json({ enroll: true, secret: s.secret, otpauthUri: s.otpauthUri, mfaToken });
    }
    res.json({ mfa_required: true, mfaToken });
  })
);

const mfaSchema = z.object({ mfaToken: z.string(), code: z.string().min(6).max(8) });

platformAuthRouter.post(
  '/mfa',
  asyncHandler(async (req, res) => {
    const { mfaToken, code } = mfaSchema.parse(req.body);
    let claims: any;
    try {
      claims = jwt.verify(mfaToken, config.jwt.accessSecret);
    } catch {
      throw unauthorized('mfa challenge expired');
    }
    if (claims.typ !== 'mfa') throw badRequest('not an mfa token');
    const u = await one<any>(`SELECT id, account_id, role, platform_role, mfa_secret_ref FROM users WHERE id=$1`, [claims.sub]);
    if (!u?.platform_role || !u.mfa_secret_ref) throw unauthorized('mfa not set up');
    const nowSec = Math.floor(Date.now() / 1000);
    if (!verifyTotp(u.mfa_secret_ref, code, { nowSec, window: 1 })) throw unauthorized('invalid code');
    await query(`UPDATE users SET mfa_enabled=true WHERE id=$1`, [u.id]);
    // full platform session — requirePlatform re-checks platform_role from the DB
    const accessToken = signAccess({ sub: u.id, account_id: u.account_id, role: u.role });
    res.json({ accessToken, platform_role: u.platform_role });
  })
);
