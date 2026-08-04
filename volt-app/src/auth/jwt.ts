import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config } from '../config';

export interface AccessClaims {
  sub: string;        // user id
  account_id: string; // tenant
  role: string;
}

export function signAccess(claims: AccessClaims): string {
  return jwt.sign(claims, config.jwt.accessSecret, { expiresIn: config.jwt.accessTtl });
}

export function verifyAccess(token: string): AccessClaims {
  return jwt.verify(token, config.jwt.accessSecret) as AccessClaims;
}

/** Opaque refresh token: random string; only its SHA-256 hash is stored in the DB. */
export function newRefreshToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, hash };
}

export const hashRefresh = (token: string) =>
  crypto.createHash('sha256').update(token).digest('hex');
