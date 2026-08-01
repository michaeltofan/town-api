/**
 * Sanitize technical-error fields for durable ops storage.
 * Never keep stacks, query strings, emails, tokens, or secret-looking values.
 */

const SECRETISH =
  /(password|passwd|secret|token|authorization|cookie|api[_-]?key|bearer|private[_-]?key|database_url|postgres(ql)?:\/\/)/i;

const EMAILISH = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function sanitizeTechnicalErrorMessage(raw: string | undefined): string {
  const fallback = 'An unexpected error occurred.';
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return fallback;
  }
  let text = raw.replace(/\s+/g, ' ').trim();
  // Drop stack frames / paths that commonly leak from Error.stack.
  const firstLine = text.split(/\r?\n/, 1)[0] ?? text;
  text = firstLine;
  text = text.replace(EMAILISH, '[redacted-email]');
  if (SECRETISH.test(text)) {
    return fallback;
  }
  if (text.length > 240) {
    text = `${text.slice(0, 237)}...`;
  }
  return text.length > 0 ? text : fallback;
}

export function sanitizeTechnicalErrorName(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  if (SECRETISH.test(name)) return null;
  return name.slice(0, 80);
}

/**
 * Prefer the route template (no query/path params values). Never include `?…`.
 */
export function sanitizeTechnicalErrorRoute(input: {
  method?: string;
  routerPath?: string;
  url?: string;
}): { method: string | null; route: string | null } {
  const method =
    typeof input.method === 'string' && input.method.trim().length > 0
      ? input.method.trim().toUpperCase().slice(0, 16)
      : null;

  let route: string | null = null;
  if (typeof input.routerPath === 'string' && input.routerPath.trim().length > 0) {
    route = input.routerPath.trim();
  } else if (typeof input.url === 'string' && input.url.trim().length > 0) {
    const pathOnly = input.url.trim().split(/[?#]/, 1)[0] ?? '';
    route = pathOnly.length > 0 ? pathOnly : null;
  }

  if (route !== null) {
    if (SECRETISH.test(route) || route.includes('@')) {
      route = '[redacted-route]';
    } else {
      route = route.slice(0, 160);
    }
  }

  return { method, route };
}

export function shouldRecordTechnicalError(input: {
  statusCode: number;
  method?: string;
  routerPath?: string;
  url?: string;
}): boolean {
  if (input.statusCode < 500 || input.statusCode > 599) return false;
  const { route } = sanitizeTechnicalErrorRoute(input);
  if (route === null) return true;
  // Avoid filling the buffer with readiness/liveness probe noise.
  if (route === '/health/live' || route === '/health/ready' || route === '/health/build') {
    return false;
  }
  return true;
}
