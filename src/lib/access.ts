export type TrustedCourseSectionAccess = {
  assignedFacultyUid?: unknown;
  enrolledStudentUids?: unknown;
};

export const PUBLIC_REGISTRATION_ROLE = 'student' as const;
export type TrustedRole = 'student' | 'faculty' | 'admin';

export const STUDENT_WORKSPACE_ROUTES = [
  '/', '/profile', '/courses', '/attendance', '/timetable', '/assignments', '/materials',
  '/examinations', '/results', '/performance', '/learning-signals', '/ai-assistant',
  '/notifications', '/settings',
] as const;
export const ADMIN_WORKSPACE_ROUTES = ['/admin/faculty', '/admin/college'] as const;
export const FACULTY_WORKSPACE_ROUTES = [
  '/', '/profile', '/subjects', '/courses', '/monitoring', '/attendance', '/marks',
  '/assignments', '/materials', '/performance', '/learning-signals', '/notifications', '/settings',
] as const;

export function normalizeWorkspacePath(pathname: string) {
  return pathname.replace(/\/+$/, '') || '/';
}

export function getWorkspaceNavigation(role: TrustedRole) {
  if (role === 'admin') {
    return [
      { path: '/admin/college', label: 'College Management', group: 'Administration' },
      { path: '/admin/faculty', label: 'Faculty Management', group: 'Administration' },
    ];
  }
  return role === 'faculty'
    ? [
      { path: '/', label: 'Overview', group: 'Academic' },
      { path: '/profile', label: 'My Profile', group: 'Academic' },
      { path: '/subjects', label: 'My Subjects', group: 'Academic' },
      { path: '/courses', label: 'Course Management', group: 'Academic' },
      { path: '/monitoring', label: 'Student Management', group: 'Teaching' },
      { path: '/attendance', label: 'Attendance Management', group: 'Teaching' },
      { path: '/marks', label: 'Marks & Grades', group: 'Teaching' },
      { path: '/assignments', label: 'Assignments', group: 'Teaching' },
      { path: '/materials', label: 'Study Materials', group: 'Teaching' },
      { path: '/performance', label: 'Student Performance', group: 'Insights' },
      { path: '/learning-signals', label: 'AI Learning Insights', group: 'Insights' },
      { path: '/notifications', label: 'Notifications', group: 'Account' },
      { path: '/settings', label: 'Settings', group: 'Account' },
    ]
    : [
      { path: '/', label: 'Overview', group: 'Academic' },
      { path: '/profile', label: 'My Profile', group: 'Academic' },
      { path: '/courses', label: 'My Courses', group: 'Academic' },
      { path: '/attendance', label: 'Attendance', group: 'Academic' },
      { path: '/timetable', label: 'Timetable', group: 'Academic' },
      { path: '/assignments', label: 'Assignments', group: 'Academic' },
      { path: '/materials', label: 'Study Materials', group: 'Academic' },
      { path: '/examinations', label: 'Examinations', group: 'Academic' },
      { path: '/results', label: 'Results & Grades', group: 'Progress' },
      { path: '/performance', label: 'Performance Analytics', group: 'Progress' },
      { path: '/learning-signals', label: 'Learning Signals', group: 'Progress' },
      { path: '/ai-assistant', label: 'AI Study Assistant', group: 'Support' },
      { path: '/notifications', label: 'Notifications', group: 'Account' },
      { path: '/settings', label: 'Settings', group: 'Account' },
    ];
}

export function getSignedOutRedirect(pathname: string): string | null {
  const normalizedPath = normalizeWorkspacePath(pathname);
  return normalizedPath === '/login' || normalizedPath === '/register' ? null : '/login';
}

export function getAuthenticatedRedirect(pathname: string, role: TrustedRole = 'student'): string | null {
  if (role === 'admin') {
    return ADMIN_WORKSPACE_ROUTES.includes(normalizeWorkspacePath(pathname) as (typeof ADMIN_WORKSPACE_ROUTES)[number])
      ? null
      : '/admin/faculty';
  }
  const allowedRoutes: readonly string[] = role === 'faculty' ? FACULTY_WORKSPACE_ROUTES : STUDENT_WORKSPACE_ROUTES;
  return allowedRoutes.includes(normalizeWorkspacePath(pathname)) ? null : '/';
}

export function canReadCourseSection(
  role: unknown,
  uid: string,
  section: TrustedCourseSectionAccess,
): boolean {
  if (!uid) return false;
  if (role === 'faculty') return section.assignedFacultyUid === uid;
  return role === 'student'
    && Array.isArray(section.enrolledStudentUids)
    && section.enrolledStudentUids.includes(uid);
}

export function canWriteCourseSection(
  role: unknown,
  uid: string,
  existingSection: TrustedCourseSectionAccess | null,
): boolean {
  return role === 'faculty'
    && Boolean(uid)
    && (!existingSection || existingSection.assignedFacultyUid === uid);
}

export function getRegistrationProfileConflict(
  existingRole: unknown,
  existingStudentAuthUserId: unknown,
  uid: string,
  userDocumentExists = existingRole !== null && existingRole !== undefined,
  existingStudentId?: unknown,
): 'role-conflict' | 'profile-conflict' | null {
  if (userDocumentExists && existingRole !== PUBLIC_REGISTRATION_ROLE) return 'role-conflict';
  if (existingRole !== null && existingRole !== undefined && existingRole !== PUBLIC_REGISTRATION_ROLE) return 'role-conflict';
  if (existingStudentAuthUserId && existingStudentAuthUserId !== uid) return 'profile-conflict';
  if (existingStudentId && existingStudentId !== uid) return 'profile-conflict';
  return null;
}
