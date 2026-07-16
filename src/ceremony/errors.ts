export class CeremonyInvariantError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CeremonyInvariantError';
    this.code = code;
  }
}
