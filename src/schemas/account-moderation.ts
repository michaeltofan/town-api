import { Type, type Static } from '@sinclair/typebox';
import { SIGNAL_HIDE_REASONS, SignalHideReasonSchema } from './signal-moderation.js';

/** Same fixed six categories as signal hide. */
export const ACCOUNT_BAN_REASONS = SIGNAL_HIDE_REASONS;

export const AccountBanReasonSchema = SignalHideReasonSchema;

export const AccountIdParamsSchema = Type.Object(
  {
    accountId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false, $id: 'AccountIdParams' },
);

export const AccountBanBodySchema = Type.Object(
  {
    reason: AccountBanReasonSchema,
  },
  { additionalProperties: false, $id: 'AccountBanBody' },
);

export const AccountUnbanBodySchema = Type.Object(
  {},
  { additionalProperties: false, $id: 'AccountUnbanBody' },
);

export const AccountStatusSchema = Type.Union(
  [
    Type.Literal('pending_email'),
    Type.Literal('pending_passkey'),
    Type.Literal('active'),
    Type.Literal('suspended'),
    Type.Literal('closed'),
  ],
  { $id: 'AccountModerationStatus' },
);

/**
 * Ban / un-ban response. Idempotent and non-active no-ops return changed=false
 * with the account's current status; state-changing calls return changed=true.
 */
export const AccountModerationResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        accountId: Type.String({ format: 'uuid' }),
        status: AccountStatusSchema,
        suspendedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        changed: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'AccountModerationResponse' },
);

export type AccountBanBody = Static<typeof AccountBanBodySchema>;
export type AccountModerationResponse = Static<typeof AccountModerationResponseSchema>;
