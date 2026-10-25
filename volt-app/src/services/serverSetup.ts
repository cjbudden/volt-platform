// ============================================================================
//  WHO SEES THE SERVER'S SETUP (build queue 1.14-G4a).
//
//  Some pages explain what is missing in terms of the server: the setting a
//  platform app's credentials go in, the mail and push settings, the cloud
//  provider's machine names. That is for whoever runs the Volt deployment. An
//  account user can do nothing with "Set SMTP_URL", and on a shared Volt it
//  describes someone else's infrastructure, so they get a plain line instead
//  ("Your Volt provider sets this up").
//
//  Who runs the deployment:
//    - a system administrator (any platform role: Volt's own staff), and
//    - on a single-client deployment (VOLT_DEPLOYMENT=single, the default),
//      the account owner, who is the one running that server.
//  Everyone else, the owner of a customer account on a shared Volt included,
//  sees the plain wording. /api/auth/me carries the answer as
//  `seesServerSetup` so the console words its pages the same way.
// ============================================================================
import type { Request } from 'express';
import { config } from '../config';

export function seesServerSetup(req: Request): boolean {
  const acc = (req as any).access as { role?: string; platformRole?: string | null } | undefined;
  if (acc?.platformRole) return true;
  return config.deployment === 'single' && acc?.role === 'owner';
}
