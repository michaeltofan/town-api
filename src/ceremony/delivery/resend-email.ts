/**
 * Shared low-level Resend plain-text email sender.
 * Used by email-verification and account-recovery delivery adapters.
 * Never logs API keys, codes, or message bodies.
 */

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
export const DEFAULT_RESEND_TIMEOUT_MS = 8_000;

export type ResendEmailDeliveryFailureReason = 'http_error' | 'timeout' | 'network';

export type ResendEmailSendInput = {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

export type ResendEmailSendResult =
  { ok: true } | { ok: false; reason: ResendEmailDeliveryFailureReason; status?: number };

export async function sendResendPlainTextEmail(
  input: ResendEmailSendInput,
): Promise<ResendEmailSendResult> {
  const fetchImpl = input.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = input.timeoutMs ?? DEFAULT_RESEND_TIMEOUT_MS;
  const body: Record<string, string> = {
    from: input.from,
    to: input.to,
    subject: input.subject,
    text: input.text,
  };
  if (input.replyTo !== undefined && input.replyTo.length > 0) {
    body.reply_to = input.replyTo;
  }

  try {
    const response = await fetchImpl(RESEND_EMAILS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status >= 200 && response.status < 300) {
      return { ok: true };
    }
    return { ok: false, reason: 'http_error', status: response.status };
  } catch (error) {
    const isTimeout =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return { ok: false, reason: isTimeout ? 'timeout' : 'network' };
  }
}

export { RESEND_EMAILS_URL };
