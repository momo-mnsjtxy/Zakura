export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }

  get isAuthenticationError() {
    return this.status === 401 || this.status === 403;
  }

  get isRetryable() {
    return this.status === 408 || this.status === 425 || this.status === 429 || this.status >= 500;
  }
}
