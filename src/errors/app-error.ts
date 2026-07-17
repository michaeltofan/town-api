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

export function controlledAccessRequiredError(): AppError {
  return new AppError(401, 'CONTROLLED_ACCESS_REQUIRED', 'Controlled access is required.');
}

export function actorNotEligibleForCommunityError(): AppError {
  return new AppError(
    403,
    'ACTOR_NOT_ELIGIBLE_FOR_COMMUNITY',
    'The actor is not eligible for this community.',
  );
}

export function civicParticipationNotAuthorizedError(): AppError {
  return new AppError(
    403,
    'CIVIC_PARTICIPATION_NOT_AUTHORIZED',
    'Civic participation is not authorized for this account.',
  );
}
