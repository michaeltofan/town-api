import {
  sendResendPlainTextEmail,
  type ResendEmailDeliveryFailureReason,
} from '../delivery/resend-email.js';
import { buildRecoveryEmail } from './messages.js';
import { isSupportedLocale, type SupportedLocale } from './policy.js';
import type {
  AccountRecoveryDeliveryAdapter,
  AccountRecoveryDeliveryInput,
  AccountRecoveryDeliveryResult,
} from './delivery.js';

export type RecoveryResendDeliveryLogEvent = {
  event: 'recovery_email_delivery_failed';
  provider: 'resend';
  reason: ResendEmailDeliveryFailureReason;
  status?: number;
  requestId?: string | null;
};

export type CreateRecoveryResendDeliveryAdapterOptions = {
  apiKey: string;
  from: string;
  replyTo?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  log?: (event: RecoveryResendDeliveryLogEvent) => void;
};

function resolveLocale(locale: string): SupportedLocale {
  if (isSupportedLocale(locale)) {
    return locale;
  }
  return 'en';
}

/**
 * Production-capable Resend delivery adapter for account recovery.
 * Sends only for outcomeCategory === 'recovery_code'; never retries.
 * Reuses shared Resend HTTP helper; never logs codes or API keys.
 */
export function createRecoveryResendDeliveryAdapter(
  options: CreateRecoveryResendDeliveryAdapterOptions,
): AccountRecoveryDeliveryAdapter {
  const { apiKey, from, replyTo, log } = options;

  return {
    mode: 'resend',
    async deliverRecoveryCode(
      input: AccountRecoveryDeliveryInput,
    ): Promise<AccountRecoveryDeliveryResult> {
      if (input.outcomeCategory !== 'recovery_code') {
        return {
          delivered: false,
          outcomeCategory: input.outcomeCategory,
        };
      }

      const locale = resolveLocale(input.locale);
      const { subject, text } = buildRecoveryEmail(locale, {
        code: input.code,
        expiresAt: input.expiresAt,
      });

      const result = await sendResendPlainTextEmail({
        apiKey,
        from,
        to: input.email,
        subject,
        text,
        ...(replyTo !== undefined ? { replyTo } : {}),
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });

      if (result.ok) {
        return {
          delivered: true,
          outcomeCategory: input.outcomeCategory,
        };
      }

      log?.({
        event: 'recovery_email_delivery_failed',
        provider: 'resend',
        reason: result.reason,
        ...(result.status !== undefined ? { status: result.status } : {}),
        requestId: input.requestId ?? null,
      });
      return {
        delivered: false,
        outcomeCategory: input.outcomeCategory,
      };
    },
  };
}
