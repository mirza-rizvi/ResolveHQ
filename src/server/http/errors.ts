export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
