export class MembershipInvariantError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MembershipInvariantError';
    this.code = code;
  }
}

export function sourceNotAllowedError(): MembershipInvariantError {
  return new MembershipInvariantError(
    'SOURCE_NOT_ALLOWED',
    'Membership source is not allowed in this environment',
  );
}

export function accountNotFoundError(): MembershipInvariantError {
  return new MembershipInvariantError('ACCOUNT_NOT_FOUND', 'Account was not found');
}

export function accountClosedError(): MembershipInvariantError {
  return new MembershipInvariantError('ACCOUNT_CLOSED', 'Closed account cannot receive membership transitions');
}

export function invalidTransitionError(reason: string): MembershipInvariantError {
  return new MembershipInvariantError('INVALID_MEMBERSHIP_TRANSITION', reason);
}
