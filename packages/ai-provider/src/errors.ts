export type ProviderErrorKind =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "network"
  | "invalid_request"
  | "unavailable"
  | "aborted"
  | "unknown";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  retryable: boolean;
  readonly detail?: string;

  constructor(kind: ProviderErrorKind, message: string, opts: { status?: number; retryable?: boolean; detail?: string } = {}) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = opts.status;
    this.retryable = opts.retryable ?? (kind === "rate_limit" || kind === "timeout" || kind === "network" || kind === "unavailable");
    this.detail = opts.detail;
  }
}

export function classifyHttp(status: number, body: string): ProviderError {
  const detail = body.slice(0, 500);
  if (status === 401 || status === 403) return new ProviderError("auth", "NVIDIA NIM rejected the credentials.", { status, detail });
  if (status === 404) return new ProviderError("unavailable", "The requested model or endpoint is not available for this account.", { status, detail, retryable: false });
  if (status === 410) return new ProviderError("unavailable", "The requested model reached end of life.", { status, detail, retryable: false });
  if (status === 429) return new ProviderError("rate_limit", "NVIDIA NIM rate limit reached.", { status, detail });
  if (status >= 500) return new ProviderError("unavailable", `NVIDIA NIM returned ${status}.`, { status, detail, retryable: true });
  if (status === 400 || status === 422) return new ProviderError("invalid_request", `NVIDIA NIM rejected the request (${status}).`, { status, detail });
  return new ProviderError("unknown", `Unexpected NVIDIA NIM status ${status}.`, { status, detail });
}
