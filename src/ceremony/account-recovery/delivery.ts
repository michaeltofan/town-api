export type AccountRecoveryDeliveryInput = {
  email: string;
  locale: string;
  code: string;
  expiresAt: string;
  purpose: 'recover_account';
  outcomeCategory: 'recovery_code' | 'suppressed' | 'unavailable';
};

export type AccountRecoveryDeliveryResult = {
  delivered: boolean;
  outcomeCategory: AccountRecoveryDeliveryInput['outcomeCategory'];
  /** Present only for test/development adapters; never logged by the application logger. */
  testOnlyCode?: string;
};

export type AccountRecoveryDeliveryAdapter = {
  readonly mode: 'test' | 'development';
  deliverRecoveryCode(input: AccountRecoveryDeliveryInput): Promise<AccountRecoveryDeliveryResult>;
};

export type TestRecoveryDeliveryRecord = AccountRecoveryDeliveryInput & {
  recordedAt: string;
};

export function createInMemoryTestRecoveryDeliveryAdapter(): AccountRecoveryDeliveryAdapter & {
  records: TestRecoveryDeliveryRecord[];
} {
  const records: TestRecoveryDeliveryRecord[] = [];
  return {
    mode: 'test',
    records,
    deliverRecoveryCode(input) {
      records.push({ ...input, recordedAt: input.expiresAt });
      return Promise.resolve({
        delivered: input.outcomeCategory === 'recovery_code',
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
export function createDevelopmentRecoveryDeliveryAdapter(): AccountRecoveryDeliveryAdapter & {
  records: TestRecoveryDeliveryRecord[];
} {
  const records: TestRecoveryDeliveryRecord[] = [];
  return {
    mode: 'development',
    records,
    deliverRecoveryCode(input) {
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
        delivered: input.outcomeCategory === 'recovery_code',
        outcomeCategory: input.outcomeCategory,
        testOnlyCode: input.code,
      });
    },
  };
}
