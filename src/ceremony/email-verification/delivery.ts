export type EmailVerificationDeliveryInput = {
  email: string;
  locale: string;
  code: string;
  expiresAt: string;
  purpose: 'verify_email';
  outcomeCategory: 'verification_code' | 'existing_account_guidance' | 'suppressed' | 'unavailable';
  /** Optional correlation id for structured delivery failure logs (never logged with the code). */
  requestId?: string | null;
};

export type EmailVerificationDeliveryResult = {
  delivered: boolean;
  outcomeCategory: EmailVerificationDeliveryInput['outcomeCategory'];
  /** Present only for test/development adapters; never logged by the application logger. */
  testOnlyCode?: string;
};

export type EmailVerificationDeliveryAdapter = {
  readonly mode: 'test' | 'development' | 'resend';
  deliverVerificationCode(
    input: EmailVerificationDeliveryInput,
  ): Promise<EmailVerificationDeliveryResult>;
};

export type TestDeliveryRecord = EmailVerificationDeliveryInput & {
  recordedAt: string;
};

export function createInMemoryTestDeliveryAdapter(): EmailVerificationDeliveryAdapter & {
  records: TestDeliveryRecord[];
} {
  const records: TestDeliveryRecord[] = [];
  return {
    mode: 'test',
    records,
    deliverVerificationCode(input) {
      records.push({ ...input, recordedAt: input.expiresAt });
      return Promise.resolve({
        delivered: input.outcomeCategory === 'verification_code',
        outcomeCategory: input.outcomeCategory,
        testOnlyCode: input.code,
      });
    },
  };
}

/**
 * Development sink that never sends real email.
 * Codes are retained only on the adapter instance for local inspection / tests.
 */
export function createDevelopmentDeliveryAdapter(): EmailVerificationDeliveryAdapter & {
  records: TestDeliveryRecord[];
} {
  const records: TestDeliveryRecord[] = [];
  return {
    mode: 'development',
    records,
    deliverVerificationCode(input) {
      records.push({
        email: input.email,
        locale: input.locale,
        code: input.code,
        expiresAt: input.expiresAt,
        purpose: input.purpose,
        outcomeCategory: input.outcomeCategory,
        recordedAt: input.expiresAt,
      });
      return Promise.resolve({
        delivered: input.outcomeCategory === 'verification_code',
        outcomeCategory: input.outcomeCategory,
        testOnlyCode: input.code,
      });
    },
  };
}
