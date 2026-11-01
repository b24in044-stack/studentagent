import type { CourseMaterial, CourseSection } from './types';
import { auth } from './firebase';
import { ApiNetworkError, ApiResponseError, readApiResponse } from './apiResponse';
import { isAllowedCourseFile } from './courseFiles';

export type StudentProfile = {
  id: string;
  name: string;
  rollNo: string;
  email?: string;
  studentId?: string;
  departmentId?: string;
  btechYear?: number;
  sectionId?: string;
  semester?: number;
  enrollmentStatus?: 'active' | 'inactive' | 'pending';
  enrollmentSectionIds?: string[];
};

export type UserRole = 'student' | 'faculty' | 'admin';

export type AdminFaculty = {
  uid: string;
  name: string;
  email: string;
  employeeId: string;
  department: string;
  status: 'active' | 'inactive';
  assignedSections: Array<{ id: string; code: string; name: string; course: string }>;
};

export type AdminSectionOption = {
  id: string;
  code: string;
  name: string;
  course: string;
  assignedFacultyUid: string | null;
};

export type AdminFacultyInput = {
  name: string;
  email: string;
  employeeId: string;
  department: string;
};

export type StudentProvisioningStatus = {
  success: true;
  uid: string;
  user: { exists: boolean; role: string | null; uidMatches: boolean };
  student: { exists: boolean; authUserIdMatches: boolean; documentUidMatches: boolean };
  eligible: boolean;
  conflict: 'role-conflict' | 'profile-conflict' | null;
};

export type AdminCollegeData = {
  departments: Array<{ id: string; name: string; code: string; status: 'active' | 'inactive' }>;
  academicYears: Array<{ id: string; departmentId: string; btechYear: number; semester: number; label: string; status: string }>;
  subjects: Array<{ id: string; code: string; name: string; departmentId: string; facultyUid: string; sectionIds: string[]; status: string }>;
  sections: Array<{
    id: string;
    code: string;
    name: string;
    course: string;
    departmentId: string;
    btechYear: number | null;
    semester: number | null;
    status: 'active' | 'inactive';
    assignedFacultyUid: string | null;
    enrolledStudentUids: string[];
    subjects: string[];
  }>;
  students: Array<{
    uid: string;
    studentId: string;
    name: string;
    email: string;
    departmentId: string;
    btechYear: number | null;
    sectionId: string;
    semester: number | null;
    enrollmentStatus: 'active' | 'inactive' | 'pending';
  }>;
};

export type StudentAcademicInput = {
  studentId: string;
  departmentId: string;
  btechYear: number;
  sectionId: string;
  semester: number;
  enrollmentStatus: 'active' | 'inactive';
};

export type SectionAssessment = {
  id: string;
  sectionId: string;
  name: string;
  type: string;
  maxMarks: number;
  date: string;
  subjectId: string;
  weightage: number;
  required: boolean;
  facultyUid: string;
  subjectName?: string;
};

export type SectionAssessmentMark = {
  id: string;
  assessmentId: string;
  studentUid: string;
  obtainedMarks: number;
  updatedAt?: string;
};

async function authenticatedApiRequest<T>(
  url: string,
  init: RequestInit = {},
  forceRefreshToken = false,
): Promise<T> {
  const user = auth?.currentUser;
  if (!user) throw new Error('Your Firebase session expired. Sign in again.');
  const idToken = await user.getIdToken(forceRefreshToken);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${idToken}`);
  if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
    });
  } catch {
    throw new ApiNetworkError();
  }
  if (response.status === 401 && !forceRefreshToken) {
    return authenticatedApiRequest<T>(url, init, true);
  }
  return readApiResponse<T>(response, 'LearnPulse API request');
}

function normalizeCourseMaterial(record: unknown): CourseMaterial {
  const material = record as Record<string, unknown>;
  const sourceValue = material.source;
  const source: CourseMaterial['source'] = sourceValue === 'Demo library' || sourceValue === 'Faculty upload' ? sourceValue : 'Faculty upload';
  const tags = Array.isArray(material.tags) ? material.tags.map((tag) => String(tag)) : [];

  return {
    id: String(material.id ?? ''),
    name: String(material.name ?? 'Untitled material'),
    type: String(material.type ?? 'FILE'),
    subject: String(material.subject ?? 'All subjects'),
    tags,
    source,
    excerpt: typeof material.excerpt === 'string' ? material.excerpt : undefined,
    fileId: typeof material.fileId === 'string' ? material.fileId : undefined,
    sizeBytes: typeof material.sizeBytes === 'number' ? material.sizeBytes : undefined,
    uploadedAt: typeof material.uploadedAt === 'string' ? material.uploadedAt : undefined,
  };
}

function normalizeSectionData(row: Record<string, unknown>, documentId: string): CourseSection {
  const cohortValue = typeof row.cohortSummary === 'object' && row.cohortSummary !== null && !Array.isArray(row.cohortSummary)
    ? row.cohortSummary as Record<string, unknown>
    : null;
  const rawSubjectAverages = cohortValue?.subjectAverages;
  const subjectAverages = typeof rawSubjectAverages === 'object' && rawSubjectAverages !== null && !Array.isArray(rawSubjectAverages)
    ? Object.fromEntries(Object.entries(rawSubjectAverages).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])))
    : {};
  const students = Array.isArray(row.students) ? row.students.map((student) => {
    const record = student as Record<string, unknown>;
    const marksValue = record.marks;
    const marks: Record<string, number> = typeof marksValue === 'object' && marksValue !== null
      ? Object.fromEntries(Object.entries(marksValue as Record<string, unknown>).map(([key, value]) => [key, Number(value ?? 0)]))
      : {};

    return {
      id: String(record.id ?? ''),
      name: String(record.name ?? 'Student'),
      rollNo: String(record.rollNo ?? ''),
      email: typeof record.email === 'string' ? record.email : undefined,
      attendance: typeof record.attendance === 'number' ? Number(record.attendance) : undefined,
      marks,
    };
  }) : [];

  const materials = Array.isArray(row.materials) ? row.materials.map((material) => normalizeCourseMaterial(material)) : [];

  return {
    id: String(row.id ?? documentId),
    code: String(row.code ?? ''),
    name: String(row.name ?? ''),
    course: String(row.course ?? ''),
    term: String(row.term ?? ''),
    faculty: String(row.faculty ?? ''),
    facultyEmail: String(row.facultyEmail ?? ''),
    room: String(row.room ?? ''),
    schedule: String(row.schedule ?? ''),
    subjects: Array.isArray(row.subjects) ? row.subjects.map((subject) => String(subject)) : [],
    ...(typeof row.departmentId === 'string' ? { departmentId: row.departmentId } : {}),
    ...(typeof row.btechYear === 'number' ? { btechYear: row.btechYear } : {}),
    ...(typeof row.semester === 'number' ? { semester: row.semester } : {}),
    ...(typeof row.section === 'string' ? { section: row.section } : {}),
    students,
    materials,
    ...(cohortValue && typeof cohortValue.studentCount === 'number' && Number.isFinite(cohortValue.studentCount)
      ? {
        cohortSummary: {
          studentCount: cohortValue.studentCount,
          ...(typeof cohortValue.overallAverage === 'number' && Number.isFinite(cohortValue.overallAverage)
            ? { overallAverage: cohortValue.overallAverage }
            : {}),
          subjectAverages,
        },
      }
      : {}),
  };
}

export async function fetchCourseSections(): Promise<CourseSection[]> {
  const payload = await authenticatedApiRequest<{ sections?: Record<string, unknown>[] }>('/api/course-sections');
  if (!Array.isArray(payload.sections)) {
    throw new ApiResponseError(200, 'INVALID_COURSE_SECTIONS_RESPONSE', 'The LearnPulse server returned an invalid course-section response.');
  }
  return payload.sections.map((section) => normalizeSectionData(section, String(section.id ?? '')));
}

export async function saveCourseSection(section: CourseSection): Promise<void> {
  if (!section.id) throw new Error('A course section ID is required.');
  const normalized = {
    id: section.id,
    code: section.code,
    name: section.name,
    course: section.course,
    term: section.term,
    faculty: section.faculty,
    facultyEmail: section.facultyEmail,
    room: section.room,
    schedule: section.schedule,
    subjects: section.subjects,
    students: section.students.map((student) => ({
      id: student.id,
      name: student.name,
      rollNo: student.rollNo,
      email: student.email,
      attendance: student.attendance,
      marks: student.marks,
    })),
    materials: section.materials.map((material) => ({
      id: material.id,
      name: material.name,
      type: material.type,
      subject: material.subject,
      tags: material.tags,
      source: material.source,
      excerpt: material.excerpt,
      fileId: material.fileId,
      sizeBytes: material.sizeBytes,
      uploadedAt: material.uploadedAt,
    })),
  };
  await authenticatedApiRequest(`/api/course-sections/${encodeURIComponent(section.id)}`, {
    method: 'PUT',
    body: JSON.stringify(normalized),
  });
}

export async function fetchAuthenticatedProfile(): Promise<{ role: UserRole; studentProfile: StudentProfile | null }> {
  const user = auth?.currentUser;
  if (!user) throw new Error('Your Firebase session expired. Sign in again.');
  const payload = await authenticatedApiRequest<{ role?: string; profile?: StudentProfile | null }>('/api/auth/profile');
  if (payload.role !== 'student' && payload.role !== 'faculty' && payload.role !== 'admin') {
    throw new Error('This account has no trusted Student, Faculty, or Admin role. Ask an administrator to provision the account.');
  }

  if (payload.role === 'student' && (!payload.profile || payload.profile.id !== user.uid)) {
    throw new Error('Your student profile is not linked to this Firebase account. Contact an administrator.');
  }
  return {
    role: payload.role,
    studentProfile: payload.role === 'student' ? payload.profile ?? null : null,
  };
}

export async function fetchAdminFaculty(): Promise<{ faculty: AdminFaculty[]; sections: AdminSectionOption[] }> {
  return authenticatedApiRequest<{ faculty: AdminFaculty[]; sections: AdminSectionOption[] }>('/api/admin/faculty');
}

export async function createAdminFaculty(input: AdminFacultyInput, temporaryPassword: string): Promise<void> {
  await authenticatedApiRequest('/api/admin/faculty', {
    method: 'POST',
    body: JSON.stringify({ ...input, temporaryPassword }),
  });
}

export async function updateAdminFaculty(uid: string, input: AdminFacultyInput): Promise<void> {
  await authenticatedApiRequest(`/api/admin/faculty/${encodeURIComponent(uid)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function setAdminFacultyStatus(uid: string, status: 'active' | 'inactive'): Promise<void> {
  await authenticatedApiRequest(`/api/admin/faculty/${encodeURIComponent(uid)}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export async function setAdminFacultySections(uid: string, sectionIds: string[]): Promise<void> {
  await authenticatedApiRequest(`/api/admin/faculty/${encodeURIComponent(uid)}/sections`, {
    method: 'PUT',
    body: JSON.stringify({ sectionIds }),
  });
}

export async function fetchAdminCollege(): Promise<AdminCollegeData> {
  return authenticatedApiRequest<AdminCollegeData>('/api/admin/college');
}

export async function fetchAdminReports(): Promise<{
  totals: { departments: number; faculty: number; students: number; sections: number };
  sections: Array<{
    sectionId: string;
    code: string;
    course: string;
    departmentId: string;
    btechYear: number | null;
    semester: number | null;
    studentCount: number;
    studentsWithMarks: number;
    averagePercentage: number | null;
    attendanceAverage: number | null;
    assignedFacultyUid: string | null;
  }>;
}> {
  return authenticatedApiRequest('/api/admin/reports');
}

export async function createAdminDepartment(input: { name: string; code: string }): Promise<void> {
  await authenticatedApiRequest('/api/admin/departments', { method: 'POST', body: JSON.stringify(input) });
}

export async function updateAdminDepartment(id: string, input: { name: string; status: 'active' | 'inactive' }): Promise<void> {
  await authenticatedApiRequest(`/api/admin/departments/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export async function createAdminAcademicYear(input: { departmentId: string; btechYear: number; semester: number; label: string }): Promise<void> {
  await authenticatedApiRequest('/api/admin/academic-years', { method: 'POST', body: JSON.stringify(input) });
}

export async function createAdminClass(input: {
  code: string;
  name: string;
  course: string;
  departmentId: string;
  btechYear: number;
  semester: number;
  section: string;
  facultyUid: string;
}): Promise<void> {
  await authenticatedApiRequest('/api/admin/classes', { method: 'POST', body: JSON.stringify(input) });
}

export async function updateAdminClass(
  sectionId: string,
  input: { name: string; facultyUid: string; status: 'active' | 'inactive' },
): Promise<void> {
  await authenticatedApiRequest(`/api/admin/classes/${encodeURIComponent(sectionId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function createAdminSubject(input: {
  code: string;
  name: string;
  departmentId: string;
  facultyUid: string;
  sectionIds: string[];
}): Promise<void> {
  await authenticatedApiRequest('/api/admin/subjects', { method: 'POST', body: JSON.stringify(input) });
}

export async function createAdminStudent(
  input: { name: string; email: string; temporaryPassword: string; academic: StudentAcademicInput },
): Promise<void> {
  await authenticatedApiRequest('/api/admin/students', { method: 'POST', body: JSON.stringify(input) });
}

export async function updateAdminStudent(
  uid: string,
  input: { name: string; academic: StudentAcademicInput },
): Promise<void> {
  await authenticatedApiRequest(`/api/admin/students/${encodeURIComponent(uid)}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export async function fetchSectionAssessments(sectionId: string): Promise<{
  assessments: SectionAssessment[];
  marks: SectionAssessmentMark[];
  weightedPercentage?: number | null;
}> {
  return authenticatedApiRequest(`/api/course-sections/${encodeURIComponent(sectionId)}/assessments`);
}

export async function createSectionAssessment(
  sectionId: string,
  input: Omit<SectionAssessment, 'id' | 'sectionId' | 'facultyUid'>,
): Promise<void> {
  await authenticatedApiRequest(`/api/course-sections/${encodeURIComponent(sectionId)}/assessments`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function saveSectionAssessmentMark(
  sectionId: string,
  assessmentId: string,
  studentUid: string,
  obtainedMarks: number,
): Promise<void> {
  await authenticatedApiRequest(
    `/api/course-sections/${encodeURIComponent(sectionId)}/assessments/${encodeURIComponent(assessmentId)}/marks/${encodeURIComponent(studentUid)}`,
    { method: 'PUT', body: JSON.stringify({ obtainedMarks }) },
  );
}

export async function uploadCourseMaterial(
  sectionId: string,
  file: File,
  subject: string,
  excerpt = '',
  replaceId?: string,
): Promise<CourseMaterial> {
  if (!isAllowedCourseFile(file.name, file.type, file.size)) {
    throw new Error('Choose a PDF, PPT/PPTX, DOC/DOCX, or TXT file up to 10 MB.');
  }
  const query = new URLSearchParams({ subject, excerpt, ...(replaceId ? { replaceId } : {}) });
  const payload = await authenticatedApiRequest<{ material?: unknown }>(
    `/api/course-sections/${encodeURIComponent(sectionId)}/materials?${query.toString()}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
      },
      body: file,
    },
  );
  if (!payload.material || typeof payload.material !== 'object') {
    throw new ApiResponseError(200, 'INVALID_MATERIAL_RESPONSE', 'The server returned an invalid course-material record.');
  }
  return normalizeCourseMaterial(payload.material);
}

export async function downloadCourseMaterial(fileId: string): Promise<Blob> {
  const user = auth?.currentUser;
  if (!user) throw new Error('Your Firebase session expired. Sign in again.');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const idToken = await user.getIdToken(attempt === 1);
    let response: Response;
    try {
      response = await fetch(`/api/course-materials/${encodeURIComponent(fileId)}/download`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
    } catch {
      throw new ApiNetworkError();
    }
    if (response.status === 401 && attempt === 0) continue;
    if (!response.ok) {
      await readApiResponse<{ error?: string }>(response, 'Course material download');
      throw new ApiResponseError(response.status, 'MATERIAL_DOWNLOAD_FAILED', 'The course material could not be downloaded.');
    }
    return response.blob();
  }
  throw new Error('Your Firebase session expired. Sign in again.');
}

export async function deleteCourseMaterial(fileId: string): Promise<void> {
  await authenticatedApiRequest(`/api/course-materials/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
}

export async function fetchStudentProvisioningStatus(): Promise<StudentProvisioningStatus> {
  const user = auth?.currentUser;
  if (!user) throw new Error('Your Firebase session expired. Sign in again.');
  const status = await authenticatedApiRequest<StudentProvisioningStatus>('/api/auth/registration-status');
  if (status.uid !== user.uid) {
    throw new Error('The server diagnostic did not match the signed-in Firebase account. No profile changes were made.');
  }
  return status;
}

export async function provisionStudentProfile(name: string): Promise<StudentProfile> {
  if (!auth) throw new Error('Firebase is not configured. Add VITE_FIREBASE_* values to your .env file and restart the app.');
  const user = auth.currentUser;
  if (!user) throw new Error('Your Firebase session expired. Sign in again to finish setting up your student profile.');
  const status = await fetchStudentProvisioningStatus();
  if (!status.eligible) {
    if (status.conflict === 'role-conflict') {
      throw new Error('This account has an existing Faculty or unsupported role. Student registration cannot change it; ask an administrator to review the account.');
    }
    throw new Error('An existing student profile is linked to a different UID. No data was changed; ask an administrator to review the profile.');
  }
  const payload = await authenticatedApiRequest<{ profile?: StudentProfile }>('/api/auth/register-profile', {
    method: 'POST',
    body: JSON.stringify({ name: name.trim() }),
  }, true);
  if (!payload.profile || payload.profile.id !== user.uid) {
    throw new Error('The server did not return a valid student profile. Please retry setup.');
  }
  return payload.profile;
}
