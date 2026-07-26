const DEVELOPER_NOTIFICATION_VERSION = '1.0';
const DECIMAL_MILLIS_PATTERN = /^(0|[1-9][0-9]{0,19})$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const NOTIFICATION_VARIANTS = [
  'subscriptionNotification',
  'oneTimeProductNotification',
  'voidedPurchaseNotification',
  'testNotification',
] as const;

type NotificationVariant = (typeof NOTIFICATION_VARIANTS)[number];

export type ParsedRtdnNotification =
  | {
      kind: 'test';
      messageId: string;
      eventTimeMillis: string;
      rawPayload: Record<string, unknown>;
      decodedPayloadBytes: Buffer;
    }
  | {
      kind: 'subscription' | 'oneTime' | 'voided';
      messageId: string;
      eventTimeMillis: string;
      notificationType: number | null;
      purchaseToken: string;
      subscriptionId: string | null;
      rawPayload: Record<string, unknown>;
      decodedPayloadBytes: Buffer;
    };

export class RtdnParseError extends Error {
  constructor() {
    super('Invalid Google Play RTDN payload.');
    this.name = 'RtdnParseError';
  }
}

function fail(): never {
  throw new RtdnParseError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(record).every((key) => allowedKeys.has(key));
}

function requireNonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail();
  }
  return value;
}

function requireNotificationType(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    fail();
  }
  return value as number;
}

function decodeBase64Utf8(value: unknown): { bytes: Buffer; text: string } {
  const encoded = requireNonEmptyString(value);
  if (encoded.length % 4 !== 0 || !BASE64_PATTERN.test(encoded)) {
    fail();
  }

  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) {
    fail();
  }
  try {
    return {
      bytes,
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    };
  } catch {
    return fail();
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      fail();
    }
    return parsed;
  } catch (error) {
    if (error instanceof RtdnParseError) {
      throw error;
    }
    return fail();
  }
}

function resolveVariant(notification: Record<string, unknown>): NotificationVariant {
  const present = NOTIFICATION_VARIANTS.filter(
    (key) => Object.prototype.hasOwnProperty.call(notification, key) && notification[key] !== null,
  );
  if (present.length !== 1) {
    fail();
  }
  const variant = present[0];
  if (variant === undefined) {
    fail();
  }
  return variant;
}

export function parseRtdnNotification(
  rawBody: Buffer,
  config: {
    packageName: string;
    subscription: string;
  },
): ParsedRtdnNotification {
  let envelope: unknown;
  try {
    envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)) as unknown;
  } catch {
    return fail();
  }
  if (
    !isRecord(envelope) ||
    !hasOnlyKeys(envelope, ['message', 'subscription']) ||
    envelope.subscription !== config.subscription ||
    !isRecord(envelope.message)
  ) {
    fail();
  }

  const messageId = requireNonEmptyString(envelope.message.messageId);
  const decoded = decodeBase64Utf8(envelope.message.data);
  const notification = parseJsonObject(decoded.text);
  if (
    !hasOnlyKeys(notification, [
      'version',
      'packageName',
      'eventTimeMillis',
      ...NOTIFICATION_VARIANTS,
    ]) ||
    notification.version !== DEVELOPER_NOTIFICATION_VERSION ||
    notification.packageName !== config.packageName ||
    typeof notification.eventTimeMillis !== 'string' ||
    !DECIMAL_MILLIS_PATTERN.test(notification.eventTimeMillis)
  ) {
    fail();
  }

  const eventTimeMillis = notification.eventTimeMillis;
  const variant = resolveVariant(notification);
  const detail = notification[variant];
  if (!isRecord(detail)) {
    fail();
  }

  if (variant === 'testNotification') {
    if (!hasOnlyKeys(detail, ['version']) || detail.version !== DEVELOPER_NOTIFICATION_VERSION) {
      fail();
    }
    return {
      kind: 'test',
      messageId,
      eventTimeMillis,
      rawPayload: notification,
      decodedPayloadBytes: decoded.bytes,
    };
  }

  if (variant === 'subscriptionNotification') {
    if (
      !hasOnlyKeys(detail, ['version', 'notificationType', 'purchaseToken', 'subscriptionId']) ||
      detail.version !== DEVELOPER_NOTIFICATION_VERSION
    ) {
      fail();
    }
    const subscriptionId =
      detail.subscriptionId === undefined ? null : requireNonEmptyString(detail.subscriptionId);
    return {
      kind: 'subscription',
      messageId,
      eventTimeMillis,
      notificationType: requireNotificationType(detail.notificationType),
      purchaseToken: requireNonEmptyString(detail.purchaseToken),
      subscriptionId,
      rawPayload: notification,
      decodedPayloadBytes: decoded.bytes,
    };
  }

  if (variant === 'oneTimeProductNotification') {
    if (
      !hasOnlyKeys(detail, ['version', 'notificationType', 'purchaseToken', 'sku']) ||
      detail.version !== DEVELOPER_NOTIFICATION_VERSION
    ) {
      fail();
    }
    requireNonEmptyString(detail.sku);
    return {
      kind: 'oneTime',
      messageId,
      eventTimeMillis,
      notificationType: requireNotificationType(detail.notificationType),
      purchaseToken: requireNonEmptyString(detail.purchaseToken),
      subscriptionId: null,
      rawPayload: notification,
      decodedPayloadBytes: decoded.bytes,
    };
  }

  if (
    !hasOnlyKeys(detail, ['purchaseToken', 'orderId', 'productType', 'refundType']) ||
    !Number.isInteger(detail.productType) ||
    !Number.isInteger(detail.refundType)
  ) {
    fail();
  }
  requireNonEmptyString(detail.orderId);
  return {
    kind: 'voided',
    messageId,
    eventTimeMillis,
    notificationType: null,
    purchaseToken: requireNonEmptyString(detail.purchaseToken),
    subscriptionId: null,
    rawPayload: notification,
    decodedPayloadBytes: decoded.bytes,
  };
}
