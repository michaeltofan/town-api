export class IdentityInvariantError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'IdentityInvariantError';
    this.code = code;
  }
}
