import { Request, Response, NextFunction, RequestHandler } from 'express';

/** Wrap an async handler so thrown errors reach the error middleware. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

/** A typed API error with an HTTP status. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (m: string) => new ApiError(400, m);
export const unauthorized = (m = 'Unauthorized') => new ApiError(401, m);
export const forbidden = (m = 'Forbidden') => new ApiError(403, m);
export const notFound = (m = 'Not found') => new ApiError(404, m);
export const conflict = (m: string) => new ApiError(409, m);

/** Central error handler (registered last in server.ts). */
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err?.name === 'ZodError') {
    return res.status(422).json({ error: 'ValidationError', details: err.issues });
  }
  // A SERVICE MAY REFUSE A REQUEST TOO, and it should not have to import the
  // HTTP layer to do it. An error carrying a plausible `status` is honoured, so
  // "that chunk is the wrong size" reaches the client as a 400 it can act on,
  // rather than a 500 that reads as our fault and invites a blind retry.
  const declared = typeof err?.status === 'number'
    && Number.isInteger(err.status) && err.status >= 400 && err.status <= 599
      ? err.status : null;
  const status = err instanceof ApiError ? err.status : (declared ?? 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message ?? 'Internal error' });
}
