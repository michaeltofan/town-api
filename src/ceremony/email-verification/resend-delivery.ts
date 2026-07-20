import { isSupportedLocale, type SupportedLocale } from './policy.js';
import { buildVerificationEmail } from './messages.js';
import type {
  EmailVerificationDeliveryAdapter,
  EmailVerificationDeliveryInput,
  EmailVerificationDeliveryResult,
} from './delivery.js';

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const DEFAULT_TIMEOUT_MS = 8_000;

export type ResendDeliveryLogEvent = {
  event: 'email_delivery_failed';
  provider: 'resend';
  reason: 'http_error' | 'timeout' | 'network';
  status?: number;
  requestId?: string | null;
};

export type CreateResendDeliveryAdapterOptions = {
  apiKey: string;
  from: string;
  replyTo?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  log?: (event: ResendDeliveryLogEvent) => void;
};

function resolveLocale(locale: string): SupportedLocale {
  if (isSupportedLocale(locale)) {
    return locale;
  }
  return 'en';
}

/**
 * Production-capable Resend delivery adapter (zero npm dependencies).
 * Sends only for outcomeCategory === 'verification_code'; never retries.
 */
export function createResendDeliveryAdapter(
  options: CreateResendDeliveryAdapterOptions,
): EmailVerificationDeliveryAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { apiKey, from, replyTo, log } = options;

  return {
    mode: 'resend',
    async deliverVerificationCode(
      input: EmailVerificationDeliveryInput,
    ): Promise<EmailVerificationDeliveryResult> {
      if (input.outcomeCategory !== 'verification_code') {
        return {
          delivered: false,
          outcomeCategory: input.outcomeCategory,
        };
      }

      const locale = resolveLocale(input.locale);
      const { subject, text } = buildVerificationEmail(locale, {
        code: input.code,
        expiresAt: input.expiresAt,
      });

      const body: Record<string, string> = {
        from,
        to: input.email,
        subject,
        text,
      };
      if (replyTo !== undefined && replyTo.length > 0) {
        body.reply_to = replyTo;
      }

      try {
        const response = await fetchImpl(RESEND_EMAILS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (response.status >= 200 && response.status < 300) {
          return {
            delivered: true,
            outcomeCategory: input.outcomeCategory,
          };
        }

        log?.({
          event: 'email_delivery_failed',
          provider: 'resend',
          reason: 'http_error',
          status: response.status,
          requestId: input.requestId ?? null,
        });
        return {
          delivered: false,
          outcomeCategory: input.outcomeCategory,
        };
      } catch (error) {
        const isTimeout =
          error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        log?.({
          event: 'email_delivery_failed',
          provider: 'resend',
          reason: isTimeout ? 'timeout' : 'network',
          requestId: input.requestId ?? null,
        });
        return {
          delivered: false,
          outcomeCategory: input.outcomeCategory,
        };
      }
    },
  };
}
