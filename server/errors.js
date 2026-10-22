// Errors that travel to the browser as ack errors (spec §5.3).
export const ERROR_CODES = Object.freeze([
  'LOCKED_IN_MODE', 'UNAVAILABLE', 'NOT_PAIRED', 'TV_OFF', 'RATE_LIMIT', 'INVALID', 'FAILED',
]);

export class LumenError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'LumenError';
    this.code = ERROR_CODES.includes(code) ? code : 'FAILED';
  }
}

// Any thrown value → the `{ code, message }` shape used in acks.
export function toErrorPayload(err) {
  if (err instanceof LumenError) return { code: err.code, message: err.message };
  return { code: 'FAILED', message: err?.message ? String(err.message) : 'Something went wrong' };
}
