/** An HTTP-style failure from a local (browser database) handler; client.ts turns it into an ApiError. */
export class LocalHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'LocalHttpError';
  }
}
