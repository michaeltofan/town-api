export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function communityNotFoundError(): AppError {
  return new AppError(404, 'COMMUNITY_NOT_FOUND', 'The requested community was not found.');
}

export function signalNotFoundError(): AppError {
  return new AppError(404, 'SIGNAL_NOT_FOUND', 'The requested signal was not found.');
}
