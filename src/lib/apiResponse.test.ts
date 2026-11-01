import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ApiResponseError,
  isRecoverableStudentProfileError,
  readApiResponse,
} from './apiResponse';

describe('Registration API response handling', () => {
  it('accepts a successful JSON profile response', async () => {
    const response = Response.json({
      success: true,
      message: 'Student profile created successfully',
      user: { uid: 'student-1', role: 'student' },
      profile: { id: 'student-1', authUserId: 'student-1' },
    });
    const payload = await readApiResponse<{ success: boolean; user: { role: string } }>(response, 'Profile setup');
    assert.equal(payload.success, true);
    assert.equal(payload.user.role, 'student');
  });

  it('reports an empty backend response without a JSON parse exception', async () => {
    await assert.rejects(
      readApiResponse(new Response('', { status: 200 }), 'Profile setup'),
      (error: unknown) => error instanceof ApiResponseError && error.code === 'EMPTY_RESPONSE',
    );
  });

  it('reports invalid JSON responses explicitly', async () => {
    await assert.rejects(
      readApiResponse(new Response('{not json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }), 'Profile setup'),
      (error: unknown) => error instanceof ApiResponseError && error.code === 'INVALID_JSON_RESPONSE',
    );
  });

  it('preserves the server message and status for HTTP 401 and 403', async () => {
    for (const [status, code, message] of [
      [401, 'AUTH_TOKEN_INVALID', 'The Firebase ID token is invalid or expired.'],
      [403, 'ROLE_CONFLICT', 'This account has a trusted Faculty role.'],
    ] as const) {
      await assert.rejects(
        readApiResponse(new Response(JSON.stringify({ success: false, code, message }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }), 'Profile setup'),
        (error: unknown) => error instanceof ApiResponseError
          && error.status === status
          && error.code === code
          && error.message === message,
      );
    }
  });

  it('surfaces provisioning failures from HTTP 500 responses', async () => {
    await assert.rejects(
      readApiResponse(new Response(JSON.stringify({
        success: false,
        code: 'PROFILE_SETUP_FAILED',
        message: 'Unable to complete student profile setup.',
      }), { status: 500, headers: { 'Content-Type': 'application/json' } }), 'Profile setup'),
      (error: unknown) => error instanceof ApiResponseError
        && error.status === 500
        && error.code === 'PROFILE_SETUP_FAILED'
        && error.message === 'Unable to complete student profile setup.',
    );
  });

  it('explains that a non-JSON 404 comes from a server without the API route', async () => {
    await assert.rejects(
      readApiResponse(new Response('<html>Backend unavailable</html>', {
        status: 404,
        headers: { 'Content-Type': 'text/html' },
      }), 'Profile setup'),
      (error: unknown) => error instanceof ApiResponseError
        && error.status === 404
        && error.code === 'HTTP_404'
        && error.message.includes('does not have the LearnPulse API route'),
    );
  });

  it('allows an existing student account with a missing profile to recover by retry', () => {
    const error = new ApiResponseError(404, 'STUDENT_PROFILE_NOT_FOUND', 'Profile missing.');
    assert.equal(isRecoverableStudentProfileError(error), true);
    assert.equal(isRecoverableStudentProfileError(new ApiResponseError(403, 'ROLE_NOT_PROVISIONED', 'Role missing.')), true);
    assert.equal(isRecoverableStudentProfileError(new ApiResponseError(403, 'UNTRUSTED_ROLE', 'Unsupported role.')), false);
    assert.equal(isRecoverableStudentProfileError(new ApiResponseError(403, 'ROLE_CONFLICT', 'Faculty account.')), false);
  });

  it('surfaces Firestore provisioning failures as a useful JSON API error', async () => {
    await assert.rejects(
      readApiResponse(new Response(JSON.stringify({
        success: false,
        code: 'PROFILE_SETUP_FAILED',
        message: 'Student profile provisioning failed. Your Firebase account is safe; retry profile setup.',
      }), { status: 500, headers: { 'Content-Type': 'application/json' } }), 'Profile setup'),
      (error: unknown) => error instanceof ApiResponseError
        && error.code === 'PROFILE_SETUP_FAILED'
        && error.message.includes('Your Firebase account is safe'),
    );
  });
});
