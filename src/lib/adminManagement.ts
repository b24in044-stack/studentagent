import type { TrustedRole } from './access';

export type FacultyProfileInput = {
  name: string;
  email: string;
  employeeId: string;
  department: string;
};

export type FacultyStatus = 'active' | 'inactive';

export function buildFacultyProfileDocuments(uid: string, profile: FacultyProfileInput) {
  return {
    user: {
      ...profile,
      uid,
      role: 'faculty' as const,
      status: 'active' as const,
    },
    faculty: {
      ...profile,
      uid,
      authUserId: uid,
      status: 'active' as const,
    },
  };
}

export function isTrustedRole(value: unknown): value is TrustedRole {
  return value === 'student' || value === 'faculty' || value === 'admin';
}

export function canAccessTrustedRole(value: unknown, allowedRoles: readonly TrustedRole[]): value is TrustedRole {
  return isTrustedRole(value) && allowedRoles.includes(value);
}

export function isAccountActive(value: { status?: unknown; disabled?: unknown } | null | undefined): boolean {
  const status = value?.status;
  return (status === undefined || status === 'active') && value?.disabled !== true;
}

export function normalizeFacultyProfileInput(value: unknown): FacultyProfileInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const email = typeof record.email === 'string' ? record.email.trim().toLowerCase() : '';
  const employeeId = typeof record.employeeId === 'string' ? record.employeeId.trim() : '';
  const department = typeof record.department === 'string' ? record.department.trim() : '';
  if (
    !name || name.length > 120
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320
    || !employeeId || employeeId.length > 64 || !/^[a-zA-Z0-9._-]+$/.test(employeeId)
    || !department || department.length > 120
  ) return null;
  return { name, email, employeeId, department };
}

export function normalizeEmployeeId(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeSectionIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 300) return null;
  const ids = value.map((item) => typeof item === 'string' ? item.trim() : '');
  if (ids.some((id) => !id || id.length > 128 || id.includes('/'))) return null;
  return [...new Set(ids)];
}
