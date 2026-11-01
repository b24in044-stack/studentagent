import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAssignedFaculty,
  isValidMark,
  normalizeAssessmentInput,
  normalizeDepartmentInput,
  normalizeStudentAcademicInput,
  normalizeSubjectInput,
  weightedAssessmentPercentage,
} from './academicManagement';

test('normalizes admin-managed department and subject records', () => {
  assert.deepEqual(normalizeDepartmentInput({ name: 'Computer Science', code: 'cse' }), {
    name: 'Computer Science',
    code: 'CSE',
  });
  assert.equal(normalizeDepartmentInput({ name: '', code: 'CSE' }), null);
  assert.deepEqual(normalizeSubjectInput({
    code: 'cse101',
    name: 'Programming',
    departmentId: 'dept-cse',
    facultyUid: 'faculty-uid',
    sectionIds: ['section-a', 'section-a'],
  }), {
    code: 'CSE101',
    name: 'Programming',
    departmentId: 'dept-cse',
    facultyUid: 'faculty-uid',
    sectionIds: ['section-a'],
  });
  assert.equal(normalizeSubjectInput({
    code: 'CSE101',
    name: 'Programming',
    departmentId: 'dept-cse',
    facultyUid: 'faculty-uid',
    sectionIds: [],
  }), null);
});

test('validates required student academic assignment fields', () => {
  assert.deepEqual(normalizeStudentAcademicInput({
    studentId: 'CSE-001',
    departmentId: 'dept-cse',
    btechYear: 2,
    sectionId: 'cse-y2-a',
    semester: 3,
    enrollmentStatus: 'active',
  }), {
    studentId: 'CSE-001',
    departmentId: 'dept-cse',
    btechYear: 2,
    sectionId: 'cse-y2-a',
    semester: 3,
    enrollmentStatus: 'active',
  });
  assert.equal(normalizeStudentAcademicInput({
    studentId: 'CSE-001',
    departmentId: 'dept-cse',
    btechYear: 5,
    sectionId: 'cse-y2-a',
    semester: 9,
    enrollmentStatus: 'active',
  }), null);
});

test('validates assessment definitions and obtained marks', () => {
  const assessment = normalizeAssessmentInput({
    name: 'Midterm',
    type: 'mid-exam',
    maxMarks: 50,
    date: '2026-10-25',
    subjectId: 'subject-cse101',
    weightage: 40,
    required: true,
  });
  assert.ok(assessment);
  assert.equal(normalizeAssessmentInput({ ...assessment, maxMarks: 0 }), null);
  assert.equal(isValidMark(50, 50), true);
  assert.equal(isValidMark(50.1, 50), false);
  assert.equal(isValidMark(Number.NaN, 50), false);
});

test('only calculates weighted grades after all required weightage is present', () => {
  const assessments = [
    { id: 'midterm', name: 'Midterm', type: 'mid-exam', maxMarks: 50, date: '2026-10-25', subjectId: 's1', weightage: 40, required: true },
    { id: 'final', name: 'Final', type: 'final-exam', maxMarks: 100, date: '2026-12-01', subjectId: 's1', weightage: 60, required: true },
  ] as const;
  assert.equal(weightedAssessmentPercentage([...assessments], { midterm: 40 }), null);
  assert.equal(weightedAssessmentPercentage([...assessments], { midterm: 40, final: 80 }), 80);
  assert.equal(weightedAssessmentPercentage([...assessments.slice(0, 1)], { midterm: 40 }), null);
});

test('calculates independent subject weights before averaging the overall percentage', () => {
  const assessments = [
    { id: 's1-a', name: 'S1 internal', type: 'internal', maxMarks: 100, date: '2026-10-25', subjectId: 's1', weightage: 100, required: true },
    { id: 's2-a', name: 'S2 internal', type: 'internal', maxMarks: 100, date: '2026-10-25', subjectId: 's2', weightage: 100, required: true },
  ] as const;
  assert.equal(weightedAssessmentPercentage([...assessments], { 's1-a': 80, 's2-a': 90 }), 85);
  assert.equal(weightedAssessmentPercentage([...assessments], { 's1-a': 80 }), null);
});

test('faculty authorization compares only the trusted UID', () => {
  assert.equal(isAssignedFaculty('faculty-a', { assignedFacultyUid: 'faculty-a' }), true);
  assert.equal(isAssignedFaculty('faculty-b', { assignedFacultyUid: 'faculty-a' }), false);
});
