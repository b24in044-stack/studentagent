import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  friendlyAuthError,
  getAccountRole,
  missingRoleMessage,
  missingStudentProfileMessage,
} from './auth';
import {
  canReadCourseSection,
  canWriteCourseSection,
  getAuthenticatedRedirect,
  getRegistrationProfileConflict,
  getSignedOutRedirect,
  getWorkspaceNavigation,
  normalizeWorkspacePath,
  PUBLIC_REGISTRATION_ROLE,
} from './access';
import { buildFacultyProfileDocuments, canAccessTrustedRole, isAccountActive, isTrustedRole, normalizeEmployeeId, normalizeFacultyProfileInput, normalizeSectionIds } from './adminManagement';

describe('Authentication helpers', () => {
  it('keeps signed-out login and registration public and redirects protected routes', () => {
    assert.equal(getSignedOutRedirect('/login'), null);
    assert.equal(getSignedOutRedirect('/register'), null);
    assert.equal(getSignedOutRedirect('/register/'), null);
    assert.equal(getSignedOutRedirect('/workspace'), '/login');
    assert.equal(normalizeWorkspacePath('/performance/'), '/performance');
  });

  it('preserves valid role-specific routes and safely redirects invalid or forbidden routes', () => {
    assert.equal(getAuthenticatedRedirect('/'), null);
    assert.equal(getAuthenticatedRedirect('/performance', 'student'), null);
    assert.equal(getAuthenticatedRedirect('/courses', 'student'), null);
    assert.equal(getAuthenticatedRedirect('/learning-signals', 'student'), null);
    assert.equal(getAuthenticatedRedirect('/monitoring', 'faculty'), null);
    assert.equal(getAuthenticatedRedirect('/courses', 'faculty'), null);
    assert.equal(getAuthenticatedRedirect('/learning-signals', 'faculty'), null);
    assert.equal(getAuthenticatedRedirect('/courses/', 'student'), null);
    assert.equal(getAuthenticatedRedirect('/monitoring', 'student'), '/');
    assert.equal(getAuthenticatedRedirect('/login'), '/');
    assert.equal(getAuthenticatedRedirect('/register'), '/');
    assert.equal(getAuthenticatedRedirect('/workspace'), '/');
    assert.equal(getAuthenticatedRedirect('/admin/faculty', 'admin'), null);
    assert.equal(getAuthenticatedRedirect('/monitoring', 'admin'), '/admin/faculty');
  });

  it('exposes the correct sidebar destinations by trusted role', () => {
    assert.deepEqual(getWorkspaceNavigation('student').map(({ path }) => path), [
      '/', '/profile', '/courses', '/attendance', '/timetable', '/assignments', '/materials',
      '/examinations', '/results', '/performance', '/learning-signals', '/ai-assistant',
      '/notifications', '/settings',
    ]);
    assert.deepEqual(getWorkspaceNavigation('faculty').map(({ path }) => path), [
      '/', '/profile', '/subjects', '/courses', '/monitoring', '/attendance', '/marks',
      '/assignments', '/materials', '/performance', '/learning-signals', '/notifications', '/settings',
    ]);
    assert.deepEqual(getWorkspaceNavigation('admin').map(({ path }) => path), ['/admin/college', '/admin/faculty']);
    assert.equal(getAuthenticatedRedirect('/ai-assistant', 'student'), null);
    assert.equal(getAuthenticatedRedirect('/marks', 'student'), '/');
    assert.equal(getAuthenticatedRedirect('/ai-assistant', 'faculty'), '/');
  });
  it('authorizes only the assigned faculty or a student explicitly enrolled by UID', () => {
    const section = { assignedFacultyUid: 'faculty-1', enrolledStudentUids: ['student-1'] };
    assert.equal(canReadCourseSection('faculty', 'faculty-1', section), true);
    assert.equal(canReadCourseSection('faculty', 'faculty-2', section), false);
    assert.equal(canReadCourseSection('student', 'student-1', section), true);
    assert.equal(canReadCourseSection('student', 'student-2', section), false);
    assert.equal(canReadCourseSection('student', 'faculty-1', section), false);
    assert.equal(canReadCourseSection('admin', 'student-1', section), false);
  });

  it('allows section writes only by the owning faculty account', () => {
    assert.equal(canWriteCourseSection('faculty', 'faculty-1', null), true);
    assert.equal(canWriteCourseSection('faculty', 'faculty-1', { assignedFacultyUid: 'faculty-1' }), true);
    assert.equal(canWriteCourseSection('faculty', 'faculty-2', { assignedFacultyUid: 'faculty-1' }), false);
    assert.equal(canWriteCourseSection('student', 'student-1', null), false);
  });

  it('keeps public registration student-only and permits only same-account profile retries', () => {
    assert.equal(PUBLIC_REGISTRATION_ROLE, 'student');
    assert.equal(getRegistrationProfileConflict(null, null, 'student-1'), null);
    assert.equal(getRegistrationProfileConflict(null, null, 'student-1', false), null);
    assert.equal(getRegistrationProfileConflict('student', 'student-1', 'student-1'), null);
    assert.equal(getRegistrationProfileConflict('student', 'student-1', 'student-1', true), null);
    assert.equal(getRegistrationProfileConflict('faculty', null, 'student-1'), 'role-conflict');
    assert.equal(getRegistrationProfileConflict('faculty', null, 'student-1', true), 'role-conflict');
    assert.equal(getRegistrationProfileConflict(undefined, null, 'student-1', true), 'role-conflict');
    assert.equal(getRegistrationProfileConflict('admin', null, 'student-1', true), 'role-conflict');
    assert.equal(getRegistrationProfileConflict('student', 'student-2', 'student-1'), 'profile-conflict');
    assert.equal(getRegistrationProfileConflict(null, null, 'student-1', false, 'student-2'), 'profile-conflict');
  });

  it('accepts only server-provisioned roles including admin', () => {
    assert.equal(getAccountRole('student'), 'student');
    assert.equal(getAccountRole('faculty'), 'faculty');
    assert.equal(getAccountRole('admin'), 'admin');
    assert.equal(getAccountRole(undefined), null);
    assert.equal(canReadCourseSection('admin', 'student-1', { assignedFacultyUid: 'student-1' }), false);
    assert.equal(canReadCourseSection(null, 'unprovisioned-uid', { assignedFacultyUid: 'unprovisioned-uid' }), false);
  });

  it('maps the most common Firebase auth errors to a helpful user message', () => {
    assert.equal(friendlyAuthError('Invalid login credentials'), 'Invalid email or password. Please check your credentials and try again.');
    assert.equal(friendlyAuthError('Email not verified'), 'Your email has not been verified yet. Check your inbox and confirm the address before signing in.');
    assert.match(friendlyAuthError('auth/email-already-in-use'), /retry student profile setup/i);
    assert.equal(friendlyAuthError('auth/invalid-email'), 'Enter a valid email address.');
    assert.equal(friendlyAuthError('auth/weak-password'), 'Choose a stronger password with at least 8 characters.');
    assert.equal(friendlyAuthError('auth/operation-not-allowed'), 'Student sign-up is currently disabled. Ask the administrator to enable Email/Password authentication.');
    assert.equal(friendlyAuthError('auth/user-disabled'), 'This account is inactive. Contact an administrator to restore access.');
    assert.equal(friendlyAuthError('Some other issue'), 'Some other issue');
  });

  describe('Admin and faculty management policy helpers', () => {
    it('recognizes admin only as a trusted server role and keeps old accounts active by default', () => {
      assert.equal(isTrustedRole('admin'), true);
      assert.equal(isTrustedRole('student'), true);
      assert.equal(isTrustedRole('owner'), false);
      assert.equal(isAccountActive({}), true);
      assert.equal(isAccountActive({ status: 'suspended' }), false);
      assert.equal(isAccountActive({ status: 'inactive' }), false);
      assert.equal(isAccountActive({ disabled: true }), false);
      assert.equal(canAccessTrustedRole('admin', ['admin']), true);
      assert.equal(canAccessTrustedRole('student', ['admin']), false);
      assert.equal(canAccessTrustedRole('faculty', ['admin']), false);
      assert.equal(canAccessTrustedRole('unknown', ['admin']), false);
    });

    it('normalizes and validates faculty identity details and unique employee identifiers', () => {
      const profile = normalizeFacultyProfileInput({
        name: '  Ada Faculty ',
        email: ' ADA@College.Example ',
        employeeId: ' EMP-01 ',
        department: ' Computer Science ',
        role: 'admin',
        password: 'should-not-be-persisted',
      });
      assert.deepEqual(profile, {
        name: 'Ada Faculty',
        email: 'ada@college.example',
        employeeId: 'EMP-01',
        department: 'Computer Science',
      });
      assert.deepEqual(buildFacultyProfileDocuments('faculty-uid', profile!), {
        user: {
          uid: 'faculty-uid',
          role: 'faculty',
          status: 'active',
          name: 'Ada Faculty',
          email: 'ada@college.example',
          employeeId: 'EMP-01',
          department: 'Computer Science',
        },
        faculty: {
          uid: 'faculty-uid',
          authUserId: 'faculty-uid',
          status: 'active',
          name: 'Ada Faculty',
          email: 'ada@college.example',
          employeeId: 'EMP-01',
          department: 'Computer Science',
        },
      });
      assert.equal(normalizeFacultyProfileInput({ name: 'Name', email: 'bad', employeeId: 'x', department: 'CS' }), null);
      assert.equal(normalizeFacultyProfileInput({ name: 'Name', email: 'name@example.com', employeeId: 'x/../../uid', department: 'CS' }), null);
      assert.equal(normalizeEmployeeId(' EMP-01 '), 'emp-01');
    });

    it('accepts only valid bounded course assignment lists', () => {
      assert.deepEqual(normalizeSectionIds(['section-1', 'section-1', 'section-2']), ['section-1', 'section-2']);
      assert.equal(normalizeSectionIds(['../users']), null);
      assert.equal(normalizeSectionIds('section-1'), null);
    });
  });

  it('provides actionable instructions for missing roles', () => {
    assert.match(missingRoleMessage(), /role/i);
    assert.match(missingRoleMessage(), /administrator/i);
  });

  it('requires a linked student profile for a verified student account', () => {
    assert.match(missingStudentProfileMessage(), /students profile/i);
    assert.match(missingStudentProfileMessage(), /authUserId/i);
  });
});
