export type ApiErrorPayload = {
  success?: false;
  code?: string;
  message?: string;
  error?: string;
};

export class ApiResponseError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiResponseError';
    this.status = status;
    this.code = code;
  }
}

export class ApiNetworkError extends Error {
  constructor() {
    super('Could not reach the LearnPulse server. Check your connection and retry profile setup.');
    this.name = 'ApiNetworkError';
  }
}

function getResponseSnippet(body: string): string {
  return body
    .replace(/<[^>]*>/g, ' ')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi, '[redacted private key]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

export async function readApiResponse<T>(
  response: Response,
  requestLabel: string,
): Promise<T> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const body = await response.text();
  let payload: (T & ApiErrorPayload) | null = null;
  let invalidJson = false;

  if (body.trim() && contentType.includes('json')) {
    try {
      payload = JSON.parse(body) as T & ApiErrorPayload;
    } catch {
      invalidJson = true;
    }
  }

  if (!response.ok) {
    const bodyMessage = payload?.message || payload?.error;
    const snippet = !contentType.includes('json') && body.trim() ? getResponseSnippet(body) : '';
    const message = response.status === 404 && !contentType.includes('json')
      ? 'The server serving this page does not have the LearnPulse API route. Restart or deploy the Express backend with the registration endpoint, and ensure the frontend sends /api requests to that backend. Your Firebase account is safe; retry profile setup after the backend is available.'
      : bodyMessage
      || (response.status === 401
        ? 'Your session could not be verified. Sign in again, then retry profile setup.'
        : snippet
          ? `${requestLabel} failed with HTTP ${response.status}: ${snippet}`
          : `${requestLabel} failed with HTTP ${response.status}.`);
    throw new ApiResponseError(
      response.status,
      payload?.code || (invalidJson ? 'INVALID_JSON_RESPONSE' : `HTTP_${response.status}`),
      message,
    );
  }

  if (!body.trim()) {
    throw new ApiResponseError(response.status, 'EMPTY_RESPONSE', `${requestLabel} returned an empty response. Retry profile setup.`);
  }
  if (!contentType.includes('json')) {
    throw new ApiResponseError(
      response.status,
      'NON_JSON_RESPONSE',
      `${requestLabel} returned an unexpected ${contentType || 'unknown'} response instead of JSON. Retry profile setup.`,
    );
  }
  if (invalidJson || !payload || typeof payload !== 'object') {
    throw new ApiResponseError(response.status, 'INVALID_JSON_RESPONSE', `${requestLabel} returned invalid JSON. Retry profile setup.`);
  }
  return payload;
}

export function isRecoverableStudentProfileError(error: unknown): error is ApiResponseError {
  return error instanceof ApiResponseError
    && ((error.status === 404 && error.code === 'STUDENT_PROFILE_NOT_FOUND')
      || (error.status === 403 && error.code === 'ROLE_NOT_PROVISIONED'));
}
