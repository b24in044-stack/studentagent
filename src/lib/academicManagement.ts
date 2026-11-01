export type AcademicDepartmentInput = {
  name: string;
  code: string;
};

export type StudentAcademicInput = {
  studentId: string;
  departmentId: string;
  btechYear: number;
  sectionId: string;
  semester: number;
  enrollmentStatus: 'active' | 'inactive';
};

export type SubjectInput = {
  code: string;
  name: string;
  departmentId: string;
  sectionIds: string[];
  facultyUid: string;
};

export const ASSESSMENT_TYPES = [
  'internal',
  'assignment',
  'class-test',
  'quiz',
  'practical',
  'mid-exam',
  'final-exam',
  'other',
] as const;

export type AssessmentInput = {
  name: string;
  type: typeof ASSESSMENT_TYPES[number];
  maxMarks: number;
  date: string;
  subjectId: string;
  weightage: number;
  required: boolean;
};

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function clean(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export function normalizeDepartmentInput(value: unknown): AcademicDepartmentInput | null {
  const record = recordOf(value);
  if (!record) return null;
  const name = clean(record.name, 120);
  const code = clean(record.code, 24).toUpperCase();
  if (!name || !/^[A-Z0-9][A-Z0-9_-]*$/.test(code)) return null;
  return { name, code };
}

export function normalizeStudentAcademicInput(value: unknown): StudentAcademicInput | null {
  const record = recordOf(value);
  if (!record) return null;
  const studentId = clean(record.studentId, 64);
  const departmentId = clean(record.departmentId, 128);
  const sectionId = clean(record.sectionId, 128);
  const btechYear = Number(record.btechYear);
  const semester = Number(record.semester);
  const enrollmentStatus = record.enrollmentStatus;
  if (
    !studentId || !/^[a-zA-Z0-9._-]+$/.test(studentId)
    || !departmentId || departmentId.includes('/')
    || !sectionId || sectionId.includes('/')
    || !Number.isInteger(btechYear) || btechYear < 1 || btechYear > 4
    || !Number.isInteger(semester) || semester < 1 || semester > 8
    || (enrollmentStatus !== 'active' && enrollmentStatus !== 'inactive')
  ) return null;
  return { studentId, departmentId, btechYear, sectionId, semester, enrollmentStatus };
}

export function normalizeSubjectInput(value: unknown): SubjectInput | null {
  const record = recordOf(value);
  if (!record) return null;
  const code = clean(record.code, 24).toUpperCase();
  const name = clean(record.name, 120);
  const departmentId = clean(record.departmentId, 128);
  const facultyUid = clean(record.facultyUid, 128);
  const sectionIds = Array.isArray(record.sectionIds)
    ? [...new Set(record.sectionIds.map((id) => clean(id, 128)).filter((id) => id && !id.includes('/')))]
    : [];
  if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(code) || !name || !departmentId || departmentId.includes('/') || !facultyUid || facultyUid.includes('/') || !sectionIds.length || sectionIds.length > 100) return null;
  return { code, name, departmentId, sectionIds, facultyUid };
}

export function normalizeAssessmentInput(value: unknown): AssessmentInput | null {
  const record = recordOf(value);
  if (!record) return null;
  const name = clean(record.name, 120);
  const type = record.type;
  const maxMarks = Number(record.maxMarks);
  const date = clean(record.date, 10);
  const subjectId = clean(record.subjectId, 128);
  const weightage = Number(record.weightage);
  const required = record.required;
  if (
    !name
    || typeof type !== 'string'
    || !ASSESSMENT_TYPES.includes(type as typeof ASSESSMENT_TYPES[number])
    || !Number.isFinite(maxMarks) || maxMarks <= 0 || maxMarks > 10000
    || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))
    || !subjectId || subjectId.includes('/')
    || !Number.isFinite(weightage) || weightage < 0 || weightage > 100
    || typeof required !== 'boolean'
  ) return null;
  return { name, type: type as AssessmentInput['type'], maxMarks, date, subjectId, weightage, required };
}

export function isValidMark(obtainedMarks: unknown, maxMarks: number): obtainedMarks is number {
  return typeof obtainedMarks === 'number'
    && Number.isFinite(obtainedMarks)
    && obtainedMarks >= 0
    && obtainedMarks <= maxMarks;
}

export function weightedAssessmentPercentage(
  assessments: Array<AssessmentInput & { id: string }>,
  marksByAssessmentId: Record<string, number>,
): number | null {
  const bySubject = new Map<string, Array<AssessmentInput & { id: string }>>();
  assessments.filter((assessment) => assessment.required && assessment.weightage > 0).forEach((assessment) => {
    const subjectAssessments = bySubject.get(assessment.subjectId) ?? [];
    subjectAssessments.push(assessment);
    bySubject.set(assessment.subjectId, subjectAssessments);
  });
  if (!bySubject.size) return null;
  const subjectGrades: number[] = [];
  for (const subjectAssessments of bySubject.values()) {
    if (subjectAssessments.some((assessment) => !Number.isFinite(marksByAssessmentId[assessment.id]))) return null;
    const totalWeight = subjectAssessments.reduce((sum, assessment) => sum + assessment.weightage, 0);
    if (Math.abs(totalWeight - 100) > 0.001) return null;
    subjectGrades.push(subjectAssessments.reduce(
      (sum, assessment) => sum + (marksByAssessmentId[assessment.id] / assessment.maxMarks) * assessment.weightage,
      0,
    ));
  }
  return subjectGrades.reduce((sum, grade) => sum + grade, 0) / subjectGrades.length;
}

export function isAssignedFaculty(uid: string, section: { assignedFacultyUid?: unknown }): boolean {
  return Boolean(uid) && section.assignedFacultyUid === uid;
}
