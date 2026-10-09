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
  // POSTGRES SAYING "THAT IS NOT A UUID" IS THE CLIENT'S FAULT, NOT OURS.
  // 22P02 (invalid_text_representation) and 22003 (numeric out of range) both
  // mean a value in the request could not be parsed into its column type. That
  // was surfacing as a 500 from at least four routes, including the PUBLIC
  // play gate — where it also handed a stranger a way to tell a malformed id
  // from a real one by status code alone. Routes still validate their own
  // parameters, because a 404 is a better answer than a 400 for an id that
  // simply does not exist; this is the net under them, so that one bad value
  // can never again read as a server fault.
  const pgBadInput = !(err instanceof ApiError) && (err?.code === '22P02' || err?.code === '22003');

  const status = err instanceof ApiError ? err.status : (declared ?? (pgBadInput ? 400 : 500));
  if (status >= 500) console.error(err);
  // The driver quotes the offending value back in its message. Harmless for a
  // uuid, but there is no reason to echo arbitrary client input, so the reply
  // is generalised while the full error is still logged above when it is ours.
  if (pgBadInput) console.warn('[http] rejected malformed input:', err.message);
  res.status(status).json({
    error: pgBadInput ? 'A value in the request is not valid for its field' : (err.message ?? 'Internal error'),
  });
}
