/**
 * Request-id validation and generation used by the Fastify request lifecycle.
 * Incoming client-supplied ids are accepted only when they match a strict,
 * safe character set and bounded length. Otherwise the runtime generates a
 * fresh `req_<uuid>` and never echoes back the client value.
 */

export const REQUEST_ID_MAX_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function isAcceptableRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && REQUEST_ID_PATTERN.test(value);
}

export type RequestIdGenerator = () => string;

const defaultUuidGenerator: RequestIdGenerator = () => crypto.randomUUID();

export function generateRequestId(uuid: RequestIdGenerator = defaultUuidGenerator): string {
  return `req_${uuid()}`;
}

/**
 * Resolve the effective request id from a raw header value. Returns the
 * validated header when acceptable; otherwise returns a fresh generated id.
 */
export function resolveRequestId(
  rawHeader: unknown,
  uuid: RequestIdGenerator = defaultUuidGenerator,
): string {
  if (isAcceptableRequestId(rawHeader)) {
    return rawHeader;
  }
  return generateRequestId(uuid);
}
