export type Role = 'faculty' | 'student' | 'admin';

export const firebaseConfigurationMessage = 'Firebase is not configured. Add VITE_FIREBASE_* values to your .env file, then restart the app.';

export function getAccountRole(value: unknown): Role | null {
  return value === 'student' || value === 'faculty' || value === 'admin' ? value : null;
}

export function friendlyAuthError(message: string): string {
  const lowered = message.toLowerCase();
  if (lowered.includes('email-already-in-use')) {
    return 'An account already exists for this email. Sign in to recover the existing account or retry student profile setup; do not create another account.';
  }
  if (lowered.includes('invalid-email')) {
    return 'Enter a valid email address.';
  }
  if (lowered.includes('weak-password')) {
    return 'Choose a stronger password with at least 8 characters.';
  }
  if (lowered.includes('network-request-failed')) {
    return 'Could not reach Firebase Authentication. Check your connection and try again.';
  }
  if (lowered.includes('too-many-requests')) {
    return 'Too many authentication attempts. Wait a few minutes and try again.';
  }
  if (lowered.includes('user-disabled')) {
    return 'This account is inactive. Contact an administrator to restore access.';
  }
  if (lowered.includes('invalid login credentials') || lowered.includes('invalid email or password') || lowered.includes('user-not-found') || lowered.includes('wrong-password')) {
    return 'Invalid email or password. Please check your credentials and try again.';
  }
  if (lowered.includes('email not verified') || lowered.includes('verify your email')) {
    return 'Your email has not been verified yet. Check your inbox and confirm the address before signing in.';
  }
  if (lowered.includes('signups disabled') || lowered.includes('signups not allowed') || lowered.includes('operation-not-allowed')) {
    return 'Student sign-up is currently disabled. Ask the administrator to enable Email/Password authentication.';
  }
  return message;
}

export function missingRoleMessage(): string {
  return 'This account has no trusted Student, Faculty, or Admin role in the Firestore users document. Ask an administrator to assign the appropriate role before the account can sign in.';
}

export function missingStudentProfileMessage(): string {
  return 'This student account is authenticated, but no matching students profile is linked to it. Ask an administrator to create the student profile and attach the authUserId.';
}
