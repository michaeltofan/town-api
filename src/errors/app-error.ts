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

export function rateLimitedError(): AppError {
  return new AppError(429, 'RATE_LIMITED', 'Rate limit exceeded.');
}

export function billingNotAvailableError(): AppError {
  return new AppError(503, 'BILLING_NOT_AVAILABLE', 'Billing is not available at this time.');
}

export function membershipAlreadyActiveError(): AppError {
  return new AppError(409, 'MEMBERSHIP_ALREADY_ACTIVE', 'Membership is already active.');
}

export function localEligibilityAlreadyBoundError(): AppError {
  return new AppError(
    409,
    'LOCAL_ELIGIBILITY_ALREADY_BOUND',
    'Local eligibility is already bound to a different community.',
  );
}

export function billingManageExistingSubscriptionError(): AppError {
  return new AppError(
    409,
    'BILLING_MANAGE_EXISTING_SUBSCRIPTION',
    'Use the billing portal to manage the existing subscription.',
  );
}

export function billingCheckoutFailedError(): AppError {
  return new AppError(502, 'BILLING_CHECKOUT_FAILED', 'Billing checkout could not be started.');
}

export function billingCustomerNotAvailableError(): AppError {
  return new AppError(
    404,
    'BILLING_CUSTOMER_NOT_AVAILABLE',
    'No billing customer is available for this account.',
  );
}

export function billingPortalFailedError(): AppError {
  return new AppError(502, 'BILLING_PORTAL_FAILED', 'Billing portal could not be started.');
}

export function googlePlayBillingNotAvailableError(): AppError {
  return new AppError(
    503,
    'GOOGLE_PLAY_BILLING_NOT_AVAILABLE',
    'Google Play billing is not available at this time.',
  );
}

export function googlePlayPurchaseRejectedError(): AppError {
  return new AppError(
    400,
    'GOOGLE_PLAY_PURCHASE_REJECTED',
    'Google Play purchase could not be verified.',
  );
}

export function googlePlayPurchaseAlreadyBoundError(): AppError {
  return new AppError(
    409,
    'GOOGLE_PLAY_PURCHASE_ALREADY_BOUND',
    'Google Play purchase is already bound to an account.',
  );
}

export function googlePlayPurchaseAcknowledgeFailedError(): AppError {
  return new AppError(
    502,
    'GOOGLE_PLAY_PURCHASE_ACKNOWLEDGE_FAILED',
    'Google Play purchase could not be acknowledged.',
  );
}
