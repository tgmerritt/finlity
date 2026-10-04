/** An HTTP-style failure from a local (browser database) handler; client.ts turns it into an ApiError. */
export class LocalHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Optional error body (for example { error_type, detail }), passed on as ApiError.data. */
    readonly data?: unknown
  ) {
    super(message);
    this.name = 'LocalHttpError';
  }
}
