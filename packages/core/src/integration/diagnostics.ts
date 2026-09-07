import type { EventSink, ResilienceEvent } from '../events.js';

type EmitFn = (lib: string, event: string, payload: unknown) => void;

/**
 * The global slot `@adonis-agora/diagnostics` publishes its `emit` under. Read
 * structurally so resilience never imports `@adonis-agora/diagnostics` — it degrades to
 * a no-op when diagnostics is not installed. See the `@adonis-agora/diagnostics`
 * decoupling contract.
 */
const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');

/**
 * Default `sanitizeError`: reduces any error down to `{ name, message }`, dropping every other
 * own property. `retry`'s and `failover`'s events carry the *raw* caught error (useful in-process,
 * e.g. to a custom `onEvent` callback that never leaves the process) — but that raw error may be a
 * gateway/HTTP client error carrying a response body, headers, or an auth token on a
 * non-standard property (`err.response.data`, `err.config.headers`, …). Forwarding it as-is to
 * diagnostics/Telescope would persist that into observability storage. `{ name, message }` is
 * enough to triage an incident without shipping arbitrary upstream payloads downstream.
 */
export function defaultSanitizeError(err: unknown): unknown {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (err === undefined) return err;
  return { name: 'Error', message: String(err) };
}

export interface DiagnosticsSinkOptions {
  /**
   * Override how an event's `error` field is serialized before it reaches the diagnostics bus.
   * Defaults to {@link defaultSanitizeError} (`{ name, message }` only). Opt into richer detail —
   * e.g. `(err) => ({ ...defaultSanitizeError(err), code: (err as any)?.code })` — only after
   * confirming the extra fields can't carry secrets/PII.
   */
  sanitizeError?: (err: unknown) => unknown;
}

/**
 * An {@link EventSink} that republishes every resilience event onto the Agora
 * diagnostics bus as `agora:resilience:<type>`, when `@adonis-agora/diagnostics` is
 * installed. `emit` is free when nothing is subscribed, so this stays cheap by
 * default; a Telescope watcher (or any `onDiagnostic('resilience', …)` handler)
 * records it when present.
 *
 * Any `error` field on the event is sanitized before it is forwarded — see
 * {@link defaultSanitizeError} and {@link DiagnosticsSinkOptions.sanitizeError}. This is the export
 * boundary: the raw error is still handed, unsanitized, to any `onEvent` you register directly on a
 * policy, since that callback runs in-process and never leaves the app.
 */
export function diagnosticsSink(opts: DiagnosticsSinkOptions = {}): EventSink {
  const sanitizeError = opts.sanitizeError ?? defaultSanitizeError;
  return (event) => {
    const emit = (globalThis as Record<symbol, unknown>)[EMIT_SLOT] as EmitFn | undefined;
    if (!emit) return;
    const payload: ResilienceEvent =
      'error' in event ? { ...event, error: sanitizeError(event.error) } : event;
    emit('resilience', event.type, payload);
  };
}
