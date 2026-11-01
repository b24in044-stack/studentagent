import 'dotenv/config';
import admin from 'firebase-admin';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createViteServer } from 'vite';
import {
  canReadCourseSection,
  canWriteCourseSection,
  getRegistrationProfileConflict,
  PUBLIC_REGISTRATION_ROLE,
  type TrustedRole,
} from './src/lib/access';
import {
  buildFacultyProfileDocuments,
  isAccountActive,
  canAccessTrustedRole,
  isTrustedRole,
  normalizeEmployeeId,
  normalizeFacultyProfileInput,
  normalizeSectionIds,
} from './src/lib/adminManagement';
import {
  isAssignedFaculty,
  isValidMark,
  ASSESSMENT_TYPES,
  normalizeAssessmentInput,
  normalizeDepartmentInput,
  normalizeStudentAcademicInput,
  normalizeSubjectInput,
  weightedAssessmentPercentage,
} from './src/lib/academicManagement';
import { isAllowedCourseFile, sanitizeCourseFileName } from './src/lib/courseFiles';

const root = path.dirname(fileURLToPath(import.meta.url));
const app = express();

let firebaseAdminApp: admin.app.App | null = null;
try {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || process.env.VITE_FIREBASE_PROJECT_ID;
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || process.env.VITE_FIREBASE_STORAGE_BUCKET;
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credentialsPath && !existsSync(path.resolve(credentialsPath))) {
    throw new Error('The configured GOOGLE_APPLICATION_CREDENTIALS file does not exist.');
  }
  const existingApp = admin.apps.find((candidate) => candidate?.name === '[DEFAULT]') ?? null;
  if (existingApp && projectId && existingApp.options.projectId !== projectId) {
    throw new Error('The initialized Firebase Admin project does not match the configured Firebase project.');
  }
  firebaseAdminApp = existingApp ?? admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    ...(projectId ? { projectId } : {}),
    ...(storageBucket ? { storageBucket } : {}),
  });
} catch (error) {
  console.error('Firebase Admin SDK initialization failed:', error instanceof Error ? error.message : 'Unknown initialization error');
}

export { firebaseAdminApp };
if (firebaseAdminApp) {
  console.info('Firebase Admin SDK initialized for project:', firebaseAdminApp.options.projectId ?? 'application-default');
}
const isProduction = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
const model = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const server = createHttpServer(app);
app.disable('x-powered-by');
app.use(express.json({ limit: '96kb' }));

type FirebaseRequest = express.Request & {
  firebaseUser?: admin.auth.DecodedIdToken;
  trustedRole?: TrustedRole;
};
type DataRecord = Record<string, unknown>;

function sendApiError(
  res: express.Response,
  status: number,
  code: string,
  message: string,
): void {
  res.status(status).json({ success: false, code, message });
}

function isDataRecord(value: unknown): value is DataRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: unknown, maxLength = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function average(values: number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function isValidDocumentId(value: string): boolean {
  return Boolean(value) && value.length <= 128 && !value.includes('/');
}

function normalizeAcademicSection(document: admin.firestore.QueryDocumentSnapshot): DataRecord {
  const section = document.data();
  return {
    id: document.id,
    code: getString(section.code, 80),
    name: getString(section.name, 120),
    course: getString(section.course, 160),
    departmentId: getString(section.departmentId, 128),
    btechYear: Number.isInteger(section.btechYear) ? section.btechYear : null,
    semester: Number.isInteger(section.semester) ? section.semester : null,
    status: section.status === 'inactive' ? 'inactive' : 'active',
    term: getString(section.term, 120),
    assignedFacultyUid: getString(section.assignedFacultyUid, 128) || null,
    enrolledStudentUids: Array.isArray(section.enrolledStudentUids)
      ? section.enrolledStudentUids.filter((uid): uid is string => typeof uid === 'string')
      : [],
    subjects: Array.isArray(section.subjects)
      ? section.subjects.filter((subject): subject is string => typeof subject === 'string')
      : [],
  };
}

function normalizeSectionForClient(
  document: admin.firestore.QueryDocumentSnapshot,
  role: 'student' | 'faculty',
  uid: string,
): DataRecord {
  const section = document.data();
  const allStudents = Array.isArray(section.students) ? section.students.filter(isDataRecord) : [];
  const subjects = Array.isArray(section.subjects) ? section.subjects.filter((subject): subject is string => typeof subject === 'string') : [];
  const students = role === 'student'
    ? allStudents.filter((student) => student.id === uid || student.authUserId === uid)
    : allStudents;
  const clientSection: DataRecord = {
    id: document.id,
    code: section.code,
    name: section.name,
    course: section.course,
    term: section.term,
    faculty: section.faculty,
    facultyEmail: section.facultyEmail,
    room: section.room,
    schedule: section.schedule,
    departmentId: section.departmentId,
    btechYear: section.btechYear,
    semester: section.semester,
    section: section.section,
    subjects,
    students: [],
    materials: Array.isArray(section.materials)
      ? section.materials.filter(isDataRecord).map((material) => ({
        id: material.id,
        name: material.name,
        type: material.type,
        subject: material.subject,
        tags: Array.isArray(material.tags) ? material.tags : [],
        source: material.source,
        ...(typeof material.fileId === 'string' ? { fileId: material.fileId } : {}),
        ...(typeof material.sizeBytes === 'number' ? { sizeBytes: material.sizeBytes } : {}),
        ...(typeof material.uploadedAt === 'string' ? { uploadedAt: material.uploadedAt } : {}),
        ...(typeof material.excerpt === 'string' ? { excerpt: material.excerpt } : {}),
      }))
      : [],
  };

  if (role === 'student') {
    const perStudentAverages = allStudents.flatMap((student) => {
      const marks = isDataRecord(student.marks) ? student.marks : {};
      const scores = subjects.map((subject) => marks[subject]).filter((mark): mark is number => typeof mark === 'number' && Number.isFinite(mark));
      return scores.length ? [average(scores)] : [];
    });
    const subjectAverages = Object.fromEntries(subjects.flatMap((subject) => {
      const marks = allStudents
        .map((student) => isDataRecord(student.marks) ? student.marks[subject] : undefined)
        .filter((mark): mark is number => typeof mark === 'number' && Number.isFinite(mark));
      return marks.length ? [[subject, average(marks)]] : [];
    }));
    clientSection.cohortSummary = {
      studentCount: allStudents.length,
      ...(perStudentAverages.length ? { overallAverage: average(perStudentAverages) } : {}),
      subjectAverages,
    };
  }

  clientSection.students = students.map((student) => ({
    id: role === 'student' ? uid : student.id,
    name: student.name,
    rollNo: student.rollNo,
    ...(typeof student.email === 'string' ? { email: student.email } : {}),
    ...(typeof student.attendance === 'number' ? { attendance: student.attendance } : {}),
    marks: isDataRecord(student.marks) ? student.marks : {},
  }));
  return clientSection;
}

async function resolveEnrolledStudentUid(
  record: DataRecord,
  firebaseAuth: admin.auth.Auth,
  firestore: admin.firestore.Firestore,
): Promise<string | null> {
  const candidateUid = getString(record.authUserId, 128) || getString(record.id, 128);
  const email = getString(record.email, 320).toLowerCase();
  let identity: admin.auth.UserRecord | null = null;

  if (candidateUid) {
    try {
      identity = await firebaseAuth.getUser(candidateUid);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code !== 'auth/user-not-found' && code !== 'auth/invalid-uid') throw error;
    }
  }
  if (!identity && email) {
    try {
      identity = await firebaseAuth.getUserByEmail(email);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code !== 'auth/user-not-found' && code !== 'auth/invalid-email') throw error;
    }
  }
  if (!identity?.email || (email && identity.email.trim().toLowerCase() !== email)) return null;

  const [userSnapshot, studentSnapshot] = await Promise.all([
    firestore.collection('users').doc(identity.uid).get(),
    firestore.collection('students').doc(identity.uid).get(),
  ]);
  if (
    userSnapshot.get('role') !== 'student'
    || !studentSnapshot.exists
    || studentSnapshot.get('authUserId') !== identity.uid
    || String(studentSnapshot.get('email') ?? '').trim().toLowerCase() !== identity.email.trim().toLowerCase()
  ) return null;

  return identity.uid;
}

const verifyFirebaseToken: express.RequestHandler = async (req, res, next) => {
  const authorization = req.header('authorization') ?? '';
  const tokenMatch = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!tokenMatch) {
    sendApiError(res, 401, 'AUTH_TOKEN_REQUIRED', 'A valid Firebase ID token is required.');
    return;
  }
  if (!firebaseAdminApp) {
    sendApiError(res, 503, 'AUTH_SERVICE_UNAVAILABLE', 'Firebase Admin authentication is unavailable. Configure server credentials and restart the API.');
    return;
  }
  try {
    (req as FirebaseRequest).firebaseUser = await firebaseAdminApp.auth().verifyIdToken(tokenMatch[1], true);
    next();
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
    console.warn('Firebase ID token verification failed:', code);
    if (code.startsWith('app/') || code === 'auth/invalid-credential') {
      sendApiError(res, 503, 'AUTH_SERVICE_UNAVAILABLE', 'Firebase Admin credentials are unavailable or invalid. Check the server credential configuration.');
      return;
    }
    sendApiError(res, 401, 'AUTH_TOKEN_INVALID', 'The Firebase ID token is invalid or expired. Sign in again.');
  }
};

function requireTrustedRole(allowedRoles: readonly TrustedRole[]): express.RequestHandler {
  return async (req, res, next) => {
    const uid = (req as FirebaseRequest).firebaseUser?.uid;
    if (!uid || !firebaseAdminApp) {
      sendApiError(res, 503, 'AUTH_SERVICE_UNAVAILABLE', 'Trusted role verification is unavailable.');
      return;
    }
    try {
      const userSnapshot = await firebaseAdminApp.firestore().collection('users').doc(uid).get();
      const userRecord = userSnapshot.data();
      const role = userRecord?.role;
      if (!userSnapshot.exists || !canAccessTrustedRole(role, allowedRoles)) {
        sendApiError(res, 403, 'ROLE_FORBIDDEN', 'Your trusted account role is not authorized for this operation.');
        return;
      }
      if (!isAccountActive(userRecord)) {
        sendApiError(res, 403, 'ACCOUNT_INACTIVE', 'This account is inactive. Contact an administrator to restore access.');
        return;
      }
      (req as FirebaseRequest).trustedRole = role;
      next();
    } catch (error) {
      console.error('Trusted role lookup failed:', error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown');
      sendApiError(res, 500, 'ROLE_LOOKUP_FAILED', 'Could not verify account permissions.');
    }
  };
}

app.post('/api/auth/register-profile', verifyFirebaseToken, async (req, res) => {
  if (!firebaseAdminApp) {
    sendApiError(res, 503, 'AUTH_SERVICE_UNAVAILABLE', 'Firebase Admin authentication is unavailable. Configure server credentials and restart the API.');
    return;
  }
  const firebaseUser = (req as FirebaseRequest).firebaseUser;
  const email = typeof firebaseUser?.email === 'string' ? firebaseUser.email.trim().toLowerCase() : '';
  const uid = firebaseUser?.uid;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!uid || !email || !name || name.length > 120) {
    sendApiError(res, 400, 'INVALID_PROFILE_REQUEST', 'A valid authenticated email and student name (1–120 characters) are required.');
    return;
  }

  const projectId = firebaseAdminApp.options.projectId ?? 'unknown';
  try {
    const firestore = firebaseAdminApp.firestore();
    const userRef = firestore.collection('users').doc(uid);
    const studentRef = firestore.collection('students').doc(uid);
    await firestore.runTransaction(async (transaction) => {
      const [userSnapshot, studentSnapshot] = await Promise.all([
        transaction.get(userRef),
        transaction.get(studentRef),
      ]);
      const conflict = getRegistrationProfileConflict(
        userSnapshot.exists ? userSnapshot.get('role') : null,
        studentSnapshot.exists ? studentSnapshot.get('authUserId') : null,
        uid,
        userSnapshot.exists,
      );
      console.info('Student profile provisioning check:', {
        uid,
        projectId,
        userDocumentExists: userSnapshot.exists,
        role: userSnapshot.exists ? userSnapshot.get('role') ?? null : null,
        studentDocumentExists: studentSnapshot.exists,
        result: conflict ? 'conflict' : 'eligible',
      });
      if (conflict) throw new Error(conflict);
      if (userSnapshot.exists && userSnapshot.get('uid') && userSnapshot.get('uid') !== uid) {
        throw new Error('profile-conflict');
      }

      const rollNo = studentSnapshot.exists
        ? String(studentSnapshot.get('rollNo') ?? `student-${uid.slice(0, 6)}`.toLowerCase())
        : `student-${uid.slice(0, 6)}`.toLowerCase();
      const studentProfile = {
        id: uid,
        studentId: uid,
        authUserId: uid,
        name: studentSnapshot.exists ? String(studentSnapshot.get('name') ?? name) : name,
        rollNo,
        email,
        departmentId: studentSnapshot.exists ? studentSnapshot.get('departmentId') ?? null : null,
        btechYear: studentSnapshot.exists ? studentSnapshot.get('btechYear') ?? null : null,
        sectionId: studentSnapshot.exists ? studentSnapshot.get('sectionId') ?? null : null,
        semester: studentSnapshot.exists ? studentSnapshot.get('semester') ?? null : null,
        enrollmentStatus: studentSnapshot.exists ? studentSnapshot.get('enrollmentStatus') ?? 'pending' : 'pending',
        enrollmentSectionIds: studentSnapshot.exists && Array.isArray(studentSnapshot.get('enrollmentSectionIds'))
          ? studentSnapshot.get('enrollmentSectionIds')
          : [],
      };
      transaction.set(userRef, { uid, role: PUBLIC_REGISTRATION_ROLE, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      transaction.set(studentRef, { ...studentProfile, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
    const [savedUser, savedStudent] = await Promise.all([userRef.get(), studentRef.get()]);
    if (
      !savedUser.exists
      || savedUser.get('uid') !== uid
      || savedUser.get('role') !== PUBLIC_REGISTRATION_ROLE
      || !savedStudent.exists
      || savedStudent.get('authUserId') !== uid
      || savedStudent.get('id') !== uid
    ) {
      sendApiError(res, 500, 'PROFILE_VERIFICATION_FAILED', 'Unable to verify the student profile after provisioning. Retry profile setup.');
      return;
    }
    const profile = savedStudent.data();
    console.info('Student profile provisioning completed:', { uid, projectId, result: 'success' });
    res.status(200).json({
      success: true,
      message: 'Student profile created successfully',
      user: { uid, role: PUBLIC_REGISTRATION_ROLE },
      profile,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'role-conflict') {
      sendApiError(res, 403, 'ROLE_CONFLICT', 'This account has a different trusted role. Student registration cannot change account roles.');
      return;
    }
    if (error instanceof Error && error.message === 'profile-conflict') {
      sendApiError(res, 409, 'PROFILE_CONFLICT', 'The existing student profile is linked to a different account. Contact an administrator.');
      return;
    }
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
    console.error('Student profile provisioning failed:', {
      uid,
      projectId,
      result: 'failed',
      code,
    });
    sendApiError(res, 500, 'PROFILE_SETUP_FAILED', 'Student profile provisioning failed. Your Firebase account is safe; retry profile setup. If this continues, contact an administrator.');
  }
});

app.get('/api/auth/profile', verifyFirebaseToken, async (req, res) => {
  if (!firebaseAdminApp) {
    res.status(503).json({ error: 'Firebase Admin authentication is unavailable. Configure server credentials and restart the API.' });
    return;
  }
  const uid = (req as FirebaseRequest).firebaseUser?.uid;
  if (!uid) {
    res.status(401).json({ error: 'A valid Firebase ID token is required.' });
    return;
  }
  try {
    const firestore = firebaseAdminApp.firestore();
    const userSnapshot = await firestore.collection('users').doc(uid).get();
    const role = userSnapshot.get('role');
    const projectId = firebaseAdminApp.options.projectId ?? 'unknown';
    console.info('Authenticated profile role lookup:', {
      uid,
      projectId,
      userDocumentExists: userSnapshot.exists,
      role: userSnapshot.exists ? role ?? null : null,
      result: !userSnapshot.exists ? 'role-not-provisioned' : isTrustedRole(role) ? 'trusted-role' : 'unsupported-role',
    });
    if (!userSnapshot.exists) {
      sendApiError(res, 403, 'ROLE_NOT_PROVISIONED', 'This Firebase account has no users profile yet. Complete Student profile setup to continue.');
      return;
    }
    if (!isTrustedRole(role)) {
      sendApiError(res, 403, 'UNTRUSTED_ROLE', 'This account has unsupported role data. Ask an administrator to review the users profile.');
      return;
    }
    if (!isAccountActive(userSnapshot.data())) {
      sendApiError(res, 403, 'ACCOUNT_INACTIVE', 'This account is inactive. Contact an administrator to restore access.');
      return;
    }
    if (role === 'faculty' || role === 'admin') {
      res.json({ role, profile: null });
      return;
    }
    const studentSnapshot = await firestore.collection('students').doc(uid).get();
    if (!studentSnapshot.exists || studentSnapshot.get('authUserId') !== uid) {
      sendApiError(res, 404, 'STUDENT_PROFILE_NOT_FOUND', 'No student profile is linked to this account. Retry student profile setup.');
      return;
    }
    res.json({ role, profile: studentSnapshot.data() });
  } catch (error) {
    console.error('Student profile lookup failed:', error instanceof Error ? error.message : 'Unknown Firestore error');
    res.status(500).json({ error: 'Could not load the student profile.' });
  }
});

app.get('/api/auth/registration-status', verifyFirebaseToken, async (req, res) => {
  if (!firebaseAdminApp) {
    sendApiError(res, 503, 'AUTH_SERVICE_UNAVAILABLE', 'Firebase Admin authentication is unavailable. Configure server credentials and restart the API.');
    return;
  }
  const uid = (req as FirebaseRequest).firebaseUser?.uid;
  if (!uid) {
    sendApiError(res, 401, 'AUTH_TOKEN_INVALID', 'A valid Firebase ID token is required.');
    return;
  }

  try {
    const firestore = firebaseAdminApp.firestore();
    const [userSnapshot, studentSnapshot] = await Promise.all([
      firestore.collection('users').doc(uid).get(),
      firestore.collection('students').doc(uid).get(),
    ]);
    const role = userSnapshot.exists ? userSnapshot.get('role') ?? null : null;
    const studentAuthUserId = studentSnapshot.exists ? studentSnapshot.get('authUserId') ?? null : null;
    const studentId = studentSnapshot.exists ? studentSnapshot.get('id') ?? null : null;
    let conflict = getRegistrationProfileConflict(role, studentAuthUserId, uid, userSnapshot.exists, studentId);
    if (userSnapshot.exists && userSnapshot.get('uid') && userSnapshot.get('uid') !== uid) {
      conflict = 'profile-conflict';
    }

    console.info('Student registration read-only diagnostic:', {
      uid,
      projectId: firebaseAdminApp.options.projectId ?? 'unknown',
      userDocumentExists: userSnapshot.exists,
      role,
      studentDocumentExists: studentSnapshot.exists,
      userUidMatches: !userSnapshot.exists || !userSnapshot.get('uid') || userSnapshot.get('uid') === uid,
      studentAuthUserIdMatches: !studentSnapshot.exists || !studentAuthUserId || studentAuthUserId === uid,
      studentDocumentUidMatches: !studentSnapshot.exists || !studentId || studentId === uid,
      eligible: !conflict,
    });

    res.json({
      success: true,
      uid,
      user: {
        exists: userSnapshot.exists,
        role,
        uidMatches: !userSnapshot.exists || !userSnapshot.get('uid') || userSnapshot.get('uid') === uid,
      },
      student: {
        exists: studentSnapshot.exists,
        authUserIdMatches: !studentSnapshot.exists || !studentAuthUserId || studentAuthUserId === uid,
        documentUidMatches: !studentSnapshot.exists || !studentId || studentId === uid,
      },
      eligible: !conflict,
      conflict,
    });
  } catch (error) {
    console.error('Student registration read-only diagnostic failed:', {
      uid,
      projectId: firebaseAdminApp.options.projectId ?? 'unknown',
      result: 'failed',
      code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown',
    });
    sendApiError(res, 500, 'PROFILE_DIAGNOSTIC_FAILED', 'Could not safely check the existing Student profile. No profile changes were made.');
  }
});

app.get('/api/course-sections', verifyFirebaseToken, requireTrustedRole(['student', 'faculty']), async (req, res) => {
  if (!firebaseAdminApp) {
    res.status(503).json({ error: 'Firebase Admin authentication is unavailable. Configure server credentials and restart the API.' });
    return;
  }
  const uid = (req as FirebaseRequest).firebaseUser?.uid;
  if (!uid) {
    res.status(401).json({ error: 'A valid Firebase ID token is required.' });
    return;
  }
  try {
    const firestore = firebaseAdminApp.firestore();
    const role = (req as FirebaseRequest).trustedRole;
    if (role === 'student') {
      const studentSnapshot = await firestore.collection('students').doc(uid).get();
      if (!studentSnapshot.exists || studentSnapshot.get('authUserId') !== uid) {
        res.status(403).json({ error: 'A linked student profile is required to access course sections.' });
        return;
      }
    } else if (role !== 'faculty') {
      res.status(403).json({ error: 'A trusted student or faculty role is required to access course sections.' });
      return;
    }

    const sectionRole = role === 'faculty' ? 'faculty' : role === 'student' ? 'student' : null;
    if (!sectionRole) {
      sendApiError(res, 403, 'ROLE_FORBIDDEN', 'Only Students and Faculty may access course sections.');
      return;
    }
    const sectionsSnapshot = sectionRole === 'faculty'
      ? await firestore.collection('courseSections').where('assignedFacultyUid', '==', uid).get()
      : await firestore.collection('courseSections').where('enrolledStudentUids', 'array-contains', uid).get();
    const sections = sectionsSnapshot.docs
      .filter((document) => document.get('status') !== 'inactive' && canReadCourseSection(sectionRole, uid, document.data()))
      .map((document) => normalizeSectionForClient(document, sectionRole, uid))
      .sort((left, right) => String(left.code ?? '').localeCompare(String(right.code ?? '')));
    res.json({ sections });
  } catch (error) {
    console.error('Course section lookup failed:', error instanceof Error ? error.message : 'Unknown Firestore error');
    res.status(500).json({ error: 'Could not load authorized course sections.' });
  }
});

app.put('/api/course-sections/:sectionId', verifyFirebaseToken, requireTrustedRole(['faculty']), async (req, res) => {
  if (!firebaseAdminApp) {
    res.status(503).json({ error: 'Firebase Admin authentication is unavailable. Configure server credentials and restart the API.' });
    return;
  }
  const uid = (req as FirebaseRequest).firebaseUser?.uid;
  const sectionIdParam = req.params.sectionId;
  const sectionId = Array.isArray(sectionIdParam) ? sectionIdParam[0] : sectionIdParam;
  if (!uid) {
    res.status(401).json({ error: 'A valid Firebase ID token is required.' });
    return;
  }
  if (!sectionId || sectionId.length > 128 || sectionId.includes('/')) {
    res.status(400).json({ error: 'A valid course section ID is required.' });
    return;
  }
  if (!isDataRecord(req.body)) {
    res.status(400).json({ error: 'A valid course section is required.' });
    return;
  }

  const body = req.body as DataRecord;
  const rawStudents = Array.isArray(body.students) ? body.students : [];
  const rawSubjects = Array.isArray(body.subjects) ? body.subjects : [];
  if (rawStudents.length > 500 || rawSubjects.length > 100 || !rawStudents.every(isDataRecord)) {
    res.status(400).json({ error: 'Student or subject data exceeds the supported size.' });
    return;
  }

  try {
    const firestore = firebaseAdminApp.firestore();
    const role = (req as FirebaseRequest).trustedRole;
    const sectionRef = firestore.collection('courseSections').doc(sectionId);
    const sectionSnapshot = await sectionRef.get();
    if (!sectionSnapshot.exists || !canWriteCourseSection(role, uid, sectionSnapshot.data() ?? null)
      || sectionSnapshot.get('status') === 'inactive') throw new Error('SECTION_ACCESS_DENIED');
    const enrolledStudentUids = Array.isArray(sectionSnapshot.get('enrolledStudentUids'))
      ? sectionSnapshot.get('enrolledStudentUids').filter((studentUid: unknown): studentUid is string => typeof studentUid === 'string')
      : [];
    const currentSubjects = Array.isArray(sectionSnapshot.get('subjects'))
      ? sectionSnapshot.get('subjects').filter((subject: unknown): subject is string => typeof subject === 'string')
      : [];
    const incomingSubjects = rawSubjects.map((subject: unknown) => getString(subject, 100)).filter(Boolean);
    if (incomingSubjects.some((subject) => !currentSubjects.includes(subject))) {
      throw new Error('ADMIN_SUBJECT_ASSIGNMENT_REQUIRED');
    }
    const subjectSnapshots = await firestore.collection('subjects').where('sectionIds', 'array-contains', sectionId).get();
    const canonicalNames = new Set(subjectSnapshots.docs.map((document) => getString(document.get('name'), 100)));
    const authorizedSubjects = new Set(subjectSnapshots.docs.filter((document) => document.get('status') !== 'inactive')
      .filter((document) => document.get('facultyUid') === uid)
      .map((document) => getString(document.get('name'), 100)));
    if (!subjectSnapshots.docs.length && isAssignedFaculty(uid, sectionSnapshot.data() ?? {})) {
      currentSubjects.forEach((subject: string) => authorizedSubjects.add(subject));
    } else if (isAssignedFaculty(uid, sectionSnapshot.data() ?? {})) {
      currentSubjects.filter((subject: string) => !canonicalNames.has(subject)).forEach((subject: string) => authorizedSubjects.add(subject));
    }
    const firebaseAuth = firebaseAdminApp.auth();
    const resolvedUids = await Promise.all(rawStudents.map((student) =>
      resolveEnrolledStudentUid(student, firebaseAuth, firestore)));
    const updatesByUid = new Map<string, { marks: DataRecord; attendance?: number }>();
    for (const [index, student] of rawStudents.entries()) {
      const studentUid = resolvedUids[index];
      if (!studentUid || !enrolledStudentUids.includes(studentUid)) throw new Error('STUDENT_NOT_ENROLLED');
      const marks = isDataRecord(student.marks) ? student.marks : {};
      const normalizedMarks: DataRecord = {};
      for (const [subject, mark] of Object.entries(marks)) {
        const subjectName = getString(subject, 100);
        if (!authorizedSubjects.has(subjectName)) throw new Error('SUBJECT_ACCESS_DENIED');
        if (typeof mark !== 'number' || !Number.isFinite(mark) || mark < 0 || mark > 100) {
          throw new Error('INVALID_MARKS');
        }
        normalizedMarks[subjectName] = mark;
      }
      if (typeof student.attendance === 'number'
        && (!Number.isFinite(student.attendance) || student.attendance < 0 || student.attendance > 100)) {
        throw new Error('INVALID_ATTENDANCE');
      }
      updatesByUid.set(studentUid, {
        marks: normalizedMarks,
        ...(typeof student.attendance === 'number' ? { attendance: student.attendance } : {}),
      });
    }

    await firestore.runTransaction(async (transaction) => {
      const existing = await transaction.get(sectionRef);
      if (!canWriteCourseSection(role, uid, existing.exists ? existing.data() ?? null : null)
        || existing.get('status') === 'inactive') {
        throw new Error('SECTION_ACCESS_DENIED');
      }
      const existingEnrolled = Array.isArray(existing.get('enrolledStudentUids'))
        ? existing.get('enrolledStudentUids').filter((studentUid: unknown): studentUid is string => typeof studentUid === 'string')
        : [];
      if ([...updatesByUid.keys()].some((studentUid) => !existingEnrolled.includes(studentUid))) {
        throw new Error('STUDENT_NOT_ENROLLED');
      }
      const existingRoster: DataRecord[] = Array.isArray(existing.get('students'))
        ? existing.get('students').filter((student: unknown): student is DataRecord => isDataRecord(student))
        : [];
      const students = existingRoster.map((student: DataRecord) => {
        const studentUid = getString(student.authUserId ?? student.id, 128);
        const changes = updatesByUid.get(studentUid);
        if (!changes) return student;
        const existingMarks = isDataRecord(student.marks) ? student.marks : {};
        return {
          ...student,
          marks: { ...existingMarks, ...changes.marks },
          ...(changes.attendance !== undefined ? { attendance: changes.attendance } : {}),
        };
      });
      transaction.update(sectionRef, {
        students,
        room: getString(body.room, 120),
        schedule: getString(body.schedule, 160),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    res.json({ saved: true });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'SECTION_ACCESS_DENIED') {
      res.status(403).json({ error: 'Only the faculty member assigned to this section can update it.' });
      return;
    }
    if (code === 'ADMIN_SUBJECT_ASSIGNMENT_REQUIRED') {
      sendApiError(res, 403, 'ADMIN_SUBJECT_ASSIGNMENT_REQUIRED', 'Only an administrator can add or change class subjects.');
      return;
    }
    if (code === 'STUDENT_NOT_ENROLLED') {
      sendApiError(res, 403, 'STUDENT_NOT_ENROLLED', 'Faculty may record data only for students already enrolled by an administrator.');
      return;
    }
    if (code === 'SUBJECT_ACCESS_DENIED') {
      sendApiError(res, 403, 'SUBJECT_ACCESS_DENIED', 'You are not assigned to one or more subjects in this class.');
      return;
    }
    if (code === 'INVALID_MARKS' || code === 'INVALID_ATTENDANCE') {
      sendApiError(res, 400, code, 'Marks and attendance values must be between 0 and 100.');
      return;
    }
    console.error('Course section save failed:', error instanceof Error ? error.message : 'Unknown Firestore error');
    res.status(500).json({ error: 'Could not save the course section.' });
  }
});

app.post(
  '/api/course-sections/:sectionId/materials',
  verifyFirebaseToken,
  requireTrustedRole(['faculty']),
  express.raw({ type: 'application/octet-stream', limit: '10mb' }),
  async (req, res) => {
    if (!firebaseAdminApp) {
      sendApiError(res, 503, 'MATERIAL_SERVICE_UNAVAILABLE', 'Private course file storage is unavailable.');
      return;
    }
    const sectionId = typeof req.params.sectionId === 'string' ? req.params.sectionId : '';
    const uid = (req as FirebaseRequest).firebaseUser?.uid ?? '';
    const fileNameHeader = req.header('x-file-name') ?? '';
    let requestedName: string;
    try {
      requestedName = decodeURIComponent(fileNameHeader);
    } catch {
      sendApiError(res, 400, 'INVALID_FILE_NAME', 'The uploaded file name is invalid.');
      return;
    }
    const fileName = sanitizeCourseFileName(requestedName);
    const contentType = req.header('content-type')?.toLowerCase() ?? '';
    const fileSize = Buffer.isBuffer(req.body) ? req.body.length : 0;
    if (!isValidDocumentId(sectionId) || !uid || !fileName
      || !isAllowedCourseFile(fileName, contentType, fileSize)
      || typeof req.query.subject !== 'string'
      || typeof req.query.excerpt !== 'string') {
      sendApiError(res, 400, 'INVALID_COURSE_FILE', 'Upload an approved PDF, PPT/PPTX, DOC/DOCX or TXT file up to 10 MB with a subject.');
      return;
    }
    const storageBucketName = process.env.FIREBASE_STORAGE_BUCKET
      || process.env.VITE_FIREBASE_STORAGE_BUCKET
      || firebaseAdminApp.options.storageBucket;
    if (!storageBucketName) {
      sendApiError(res, 503, 'STORAGE_BUCKET_REQUIRED', 'Configure FIREBASE_STORAGE_BUCKET to enable private course file storage.');
      return;
    }
    const subject = getString(req.query.subject, 100);
    const excerpt = getString(req.query.excerpt, 6000);
    const firestore = firebaseAdminApp.firestore();
    const sectionRef = firestore.collection('courseSections').doc(sectionId);
    const replaceId = typeof req.query.replaceId === 'string' ? req.query.replaceId : '';
    if (replaceId && !isValidDocumentId(replaceId)) {
      sendApiError(res, 400, 'INVALID_MATERIAL_REQUEST', 'The material selected for replacement is invalid.');
      return;
    }
    const fileId = replaceId || randomUUID();
    const storagePath = `course-materials/${sectionId}/${fileId}/${randomUUID()}-${fileName}`;
    const storageFile = firebaseAdminApp.storage().bucket(storageBucketName).file(storagePath);
    const materialRef = firestore.collection('courseMaterials').doc(fileId);
    let oldStoragePath = '';
    let uploadCommitted = false;
    const material = {
      id: fileId,
      fileId,
      name: fileName,
      type: fileName.split('.').pop()?.toUpperCase() ?? 'FILE',
      subject,
      tags: [subject.toLowerCase(), 'faculty upload'],
      source: 'Faculty upload',
      sizeBytes: fileSize,
      uploadedAt: new Date().toISOString(),
      ...(excerpt ? { excerpt } : {}),
    };
    try {
      const section = await sectionRef.get();
      const subjects = Array.isArray(section.get('subjects')) ? section.get('subjects') : [];
      if (!section.exists || section.get('status') === 'inactive' || !isAssignedFaculty(uid, section.data() ?? {})) {
        sendApiError(res, 403, 'SECTION_ACCESS_DENIED', 'Only the faculty member assigned to this active section may upload materials.');
        return;
      }
      if (!subjects.includes(subject)) {
        sendApiError(res, 403, 'SUBJECT_ACCESS_DENIED', 'Choose a subject configured for this class.');
        return;
      }
      if (replaceId) {
        const previousMaterial = await materialRef.get();
        if (!previousMaterial.exists || previousMaterial.get('sectionId') !== sectionId || previousMaterial.get('facultyUid') !== uid) {
          sendApiError(res, 404, 'MATERIAL_NOT_FOUND', 'Only a material owned by this faculty account in this section can be replaced.');
          return;
        }
        oldStoragePath = getString(previousMaterial.get('storagePath'), 512);
      }
      await storageFile.save(req.body as Buffer, {
        resumable: false,
        metadata: {
          contentType,
          cacheControl: 'private, no-store',
          metadata: { uploadedByUid: uid, sectionId },
        },
      });
      await firestore.runTransaction(async (transaction) => {
        const [currentSection, currentMaterial] = await Promise.all([
          transaction.get(sectionRef),
          ...(replaceId ? [transaction.get(materialRef)] : []),
        ]);
        if (!currentSection.exists || currentSection.get('status') === 'inactive'
          || !isAssignedFaculty(uid, currentSection.data() ?? {})) {
          throw new Error('SECTION_ACCESS_DENIED');
        }
        if (replaceId && (!currentMaterial?.exists || currentMaterial.get('sectionId') !== sectionId || currentMaterial.get('facultyUid') !== uid)) {
          throw new Error('MATERIAL_NOT_FOUND');
        }
        const currentMaterials: DataRecord[] = Array.isArray(currentSection.get('materials'))
          ? currentSection.get('materials').filter(isDataRecord)
          : [];
        const materialData = {
          ...material,
          sectionId,
          departmentId: currentSection.get('departmentId') ?? null,
          facultyUid: uid,
          storagePath,
          contentType,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        if (replaceId) transaction.update(materialRef, materialData);
        else transaction.create(materialRef, materialData);
        transaction.update(sectionRef, {
          materials: [material, ...currentMaterials.filter((entry) => entry.fileId !== fileId)],
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
      uploadCommitted = true;
      if (oldStoragePath && oldStoragePath !== storagePath) {
        await firebaseAdminApp.storage().bucket(storageBucketName).file(oldStoragePath).delete({ ignoreNotFound: true });
      }
      res.status(201).json({ material });
    } catch (error) {
      if (!uploadCommitted) {
        try {
          await storageFile.delete({ ignoreNotFound: true });
        } catch (cleanupError) {
          console.error('Course file upload cleanup failed:', cleanupError && typeof cleanupError === 'object' && 'code' in cleanupError ? String(cleanupError.code) : 'unknown');
        }
      }
      if (error instanceof Error && error.message === 'SECTION_ACCESS_DENIED') {
        sendApiError(res, 403, 'SECTION_ACCESS_DENIED', 'Section access changed before the file upload completed.');
        return;
      }
      if (error instanceof Error && error.message === 'MATERIAL_NOT_FOUND') {
        sendApiError(res, 404, 'MATERIAL_NOT_FOUND', 'The course material could not be replaced.');
        return;
      }
      console.error('Course file upload failed:', error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown');
      sendApiError(res, 500, 'COURSE_FILE_UPLOAD_FAILED', 'The private course file could not be stored.');
    }
  },
);

app.get('/api/course-materials/:fileId/download', verifyFirebaseToken, requireTrustedRole(['student', 'faculty']), async (req, res) => {
  if (!firebaseAdminApp) {
    sendApiError(res, 503, 'MATERIAL_SERVICE_UNAVAILABLE', 'Private course file storage is unavailable.');
    return;
  }
  const fileId = typeof req.params.fileId === 'string' ? req.params.fileId : '';
  const uid = (req as FirebaseRequest).firebaseUser?.uid ?? '';
  const role = (req as FirebaseRequest).trustedRole;
  if (!isValidDocumentId(fileId) || !uid || (role !== 'student' && role !== 'faculty')) {
    sendApiError(res, 400, 'INVALID_MATERIAL_REQUEST', 'A valid course material is required.');
    return;
  }
  try {
    const materialSnapshot = await firebaseAdminApp.firestore().collection('courseMaterials').doc(fileId).get();
    if (!materialSnapshot.exists) {
      sendApiError(res, 404, 'MATERIAL_NOT_FOUND', 'The course file was not found.');
      return;
    }
    const materialData = materialSnapshot.data() ?? {};
    const sectionId = getString(materialData.sectionId, 128);
    const section = await firebaseAdminApp.firestore().collection('courseSections').doc(sectionId).get();
    const sectionData = section.data() ?? {};
    const canAccess = role === 'faculty'
      ? isAssignedFaculty(uid, sectionData)
      : canReadCourseSection('student', uid, sectionData);
    if (!section.exists || section.get('status') === 'inactive' || !canAccess) {
      sendApiError(res, 403, 'MATERIAL_ACCESS_DENIED', 'You are not enrolled in or assigned to this course material.');
      return;
    }
    if (role === 'student') {
      const student = await firebaseAdminApp.firestore().collection('students').doc(uid).get();
      if (!student.exists || student.get('authUserId') !== uid || student.get('enrollmentStatus') === 'inactive') {
        sendApiError(res, 403, 'STUDENT_PROFILE_REQUIRED', 'An active linked Student profile is required.');
        return;
      }
    }
    const storagePath = getString(materialData.storagePath, 512);
    if (!storagePath.startsWith(`course-materials/${sectionId}/`) || storagePath.includes('..')) {
      sendApiError(res, 404, 'MATERIAL_NOT_FOUND', 'The stored course file is unavailable.');
      return;
    }
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET
      || process.env.VITE_FIREBASE_STORAGE_BUCKET
      || firebaseAdminApp.options.storageBucket;
    if (!bucketName) {
      sendApiError(res, 503, 'STORAGE_BUCKET_REQUIRED', 'Configure FIREBASE_STORAGE_BUCKET to enable private course file storage.');
      return;
    }
    const file = firebaseAdminApp.storage().bucket(bucketName).file(storagePath);
    const [exists] = await file.exists();
    if (!exists) {
      sendApiError(res, 404, 'MATERIAL_FILE_MISSING', 'The file record exists but its private storage object is missing.');
      return;
    }
    const fileName = sanitizeCourseFileName(getString(materialData.name, 180)) ?? 'course-material';
    res.setHeader('Content-Type', getString(materialData.contentType, 100) || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const stream = file.createReadStream();
    stream.on('error', () => {
      if (!res.headersSent) sendApiError(res, 500, 'MATERIAL_DOWNLOAD_FAILED', 'The course file could not be downloaded.');
      else res.destroy();
    });
    stream.pipe(res);
  } catch (error) {
    console.error('Course file download failed:', error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown');
    if (!res.headersSent) sendApiError(res, 500, 'MATERIAL_DOWNLOAD_FAILED', 'The course file could not be downloaded.');
  }
});

app.delete('/api/course-materials/:fileId', verifyFirebaseToken, requireTrustedRole(['faculty']), async (req, res) => {
  if (!firebaseAdminApp) {
    sendApiError(res, 503, 'MATERIAL_SERVICE_UNAVAILABLE', 'Private course file storage is unavailable.');
    return;
  }
  const fileId = typeof req.params.fileId === 'string' ? req.params.fileId : '';
  const uid = (req as FirebaseRequest).firebaseUser?.uid ?? '';
  if (!isValidDocumentId(fileId) || !uid) {
    sendApiError(res, 400, 'INVALID_MATERIAL_REQUEST', 'A valid course material is required.');
    return;
  }
  const firestore = firebaseAdminApp.firestore();
  const materialRef = firestore.collection('courseMaterials').doc(fileId);
  let storagePath = '';
  try {
    await firestore.runTransaction(async (transaction) => {
      const material = await transaction.get(materialRef);
      if (!material.exists || material.get('facultyUid') !== uid) throw new Error('MATERIAL_NOT_FOUND');
      storagePath = getString(material.get('storagePath'), 512);
      const sectionId = getString(material.get('sectionId'), 128);
      const sectionRef = firestore.collection('courseSections').doc(sectionId);
      const section = await transaction.get(sectionRef);
      if (!section.exists || !isAssignedFaculty(uid, section.data() ?? {})) throw new Error('SECTION_ACCESS_DENIED');
      const materials: DataRecord[] = Array.isArray(section.get('materials')) ? section.get('materials').filter(isDataRecord) : [];
      transaction.update(sectionRef, {
        materials: materials.filter((entry) => entry.fileId !== fileId),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      transaction.delete(materialRef);
    });
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET
      || process.env.VITE_FIREBASE_STORAGE_BUCKET
      || firebaseAdminApp.options.storageBucket;
    if (!bucketName || !storagePath) {
      sendApiError(res, 500, 'MATERIAL_DELETE_PARTIAL', 'The material metadata was removed, but the private storage object could not be located for cleanup.');
      return;
    }
    await firebaseAdminApp.storage().bucket(bucketName).file(storagePath).delete({ ignoreNotFound: true });
    res.json({ deleted: true });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'MATERIAL_NOT_FOUND') {
      sendApiError(res, 404, 'MATERIAL_NOT_FOUND', 'The course material was not found or is not owned by this faculty account.');
      return;
    }
    if (code === 'SECTION_ACCESS_DENIED') {
      sendApiError(res, 403, 'SECTION_ACCESS_DENIED', 'Only faculty assigned to the section may delete its materials.');
      return;
    }
    console.error('Course file deletion failed:', error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown');
    sendApiError(res, 500, 'MATERIAL_DELETE_FAILED', 'Could not delete the private course file.');
  }
});

app.get('/api/faculty/access', verifyFirebaseToken, requireTrustedRole(['faculty']), async (req, res) => {
  if (!firebaseAdminApp) {
    res.status(503).json({ error: 'Firebase Admin authentication is unavailable. Configure server credentials and restart the API.' });
    return;
  }
  const uid = (req as FirebaseRequest).firebaseUser?.uid;
  if (!uid) {
    res.status(401).json({ error: 'A valid Firebase ID token is required.' });
    return;
  }
  try {
    res.json({ authorized: true });
  } catch (error) {
    console.error('Faculty authorization check failed:', error instanceof Error ? error.message : 'Unknown Firestore error');
    res.status(500).json({ error: 'Could not verify faculty permissions.' });
  }
});

app.get('/api/admin/faculty', verifyFirebaseToken, requireTrustedRole(['admin']), async (_req, res) => {
  if (!firebaseAdminApp) {
    sendApiError(res, 503, 'ADMIN_SERVICE_UNAVAILABLE', 'Faculty management is unavailable.');
    return;
  }
  try {
    const firestore = firebaseAdminApp.firestore();
    const [facultyProfiles, facultyUsers, courseSections] = await Promise.all([
      firestore.collection('faculty').get(),
      firestore.collection('users').where('role', '==', 'faculty').get(),
      firestore.collection('courseSections').get(),
    ]);
    const profileByUid = new Map(facultyProfiles.docs.map((document) => [document.id, document.data()]));
    const userByUid = new Map(facultyUsers.docs.map((document) => [document.id, document.data()]));
    const assignedByUid = new Map<string, Array<{ id: string; code: string; name: string; course: string }>>();
    const sectionOptions = courseSections.docs.map((document) => {
      const section = document.data();
      const assignedFacultyUid = typeof section.assignedFacultyUid === 'string' ? section.assignedFacultyUid : null;
      if (assignedFacultyUid) {
        const assigned = assignedByUid.get(assignedFacultyUid) ?? [];
        assigned.push({
          id: document.id,
          code: getString(section.code, 80),
          name: getString(section.name, 120),
          course: getString(section.course, 160),
        });
        assignedByUid.set(assignedFacultyUid, assigned);
      }
      return {
        id: document.id,
        code: getString(section.code, 80),
        name: getString(section.name, 120),
        course: getString(section.course, 160),
        assignedFacultyUid,
      };
    });
    const faculty = facultyUsers.docs.map((document) => {
      const user = document.data();
      const profile = profileByUid.get(document.id) ?? user;
      return {
        uid: document.id,
        name: getString(profile.name ?? user.name, 120),
        email: getString(profile.email ?? user.email, 320).toLowerCase(),
        employeeId: getString(profile.employeeId, 64),
        department: getString(profile.department, 120),
        status: isAccountActive({ status: profile.status ?? user.status, disabled: profile.disabled ?? user.disabled }) ? 'active' : 'inactive',
        assignedSections: assignedByUid.get(document.id) ?? [],
      };
    }).sort((left, right) => left.name.localeCompare(right.name));
    res.json({ faculty, sections: sectionOptions });
  } catch (error) {
    console.error('Admin faculty listing failed:', error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown');
    sendApiError(res, 500, 'FACULTY_LIST_FAILED', 'Could not load faculty accounts.');
  }
});

app.post('/api/admin/faculty', verifyFirebaseToken, requireTrustedRole(['admin']), async (req, res) => {
  if (!firebaseAdminApp) {
    sendApiError(res, 503, 'ADMIN_SERVICE_UNAVAILABLE', 'Faculty management is unavailable.');
    return;
  }
  const profile = normalizeFacultyProfileInput(req.body);
  const temporaryPassword = typeof req.body?.temporaryPassword === 'string' ? req.body.temporaryPassword : '';
  if (!profile || temporaryPassword.length < 12 || temporaryPassword.length > 128) {
    sendApiError(res, 400, 'INVALID_FACULTY_REQUEST', 'Provide a valid name, email, employee ID, department, and temporary password of 12–128 characters.');
    return;
  }

  const firestore = firebaseAdminApp.firestore();
  const employeeRef = firestore.collection('facultyEmployeeIds').doc(normalizeEmployeeId(profile.employeeId));
  let createdUser: admin.auth.UserRecord | null = null;
  try {
    const [existingEmployeeIndex, existingFacultyProfiles, existingFacultyUsers] = await Promise.all([
      employeeRef.get(),
      firestore.collection('faculty').get(),
      firestore.collection('users').where('role', '==', 'faculty').get(),
    ]);
    const existingEmployeeId = existingFacultyProfiles.docs.some((document) =>
      normalizeEmployeeId(getString(document.get('employeeId'), 64)) === normalizeEmployeeId(profile.employeeId))
      || existingFacultyUsers.docs.some((document) =>
        normalizeEmployeeId(getString(document.get('employeeId'), 64)) === normalizeEmployeeId(profile.employeeId));
    if (existingEmployeeIndex.exists || existingEmployeeId) {
      sendApiError(res, 409, 'EMPLOYEE_ID_EXISTS', 'A faculty account already uses this employee ID.');
      return;
    }
    try {
      createdUser = await firebaseAdminApp.auth().createUser({
        email: profile.email,
        password: temporaryPassword,
        displayName: profile.name,
        disabled: true,
        emailVerified: false,
      });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code === 'auth/email-already-exists') {
        sendApiError(res, 409, 'FACULTY_EMAIL_EXISTS', 'A Firebase account already uses this email address.');
        return;
      }
      throw error;
    }

    const uid = createdUser.uid;
    const userRef = firestore.collection('users').doc(uid);
    const facultyRef = firestore.collection('faculty').doc(uid);
    await firestore.runTransaction(async (transaction) => {
      const [userSnapshot, facultySnapshot, employeeSnapshot] = await Promise.all([
        transaction.get(userRef),
        transaction.get(facultyRef),
        transaction.get(employeeRef),
      ]);
      if (employeeSnapshot.exists) throw new Error('EMPLOYEE_ID_EXISTS');
      if (userSnapshot.exists || facultySnapshot.exists) throw new Error('FACULTY_PROFILE_EXISTS');
      const now = admin.firestore.FieldValue.serverTimestamp();
      const documents = buildFacultyProfileDocuments(uid, profile);
      transaction.create(userRef, {
        ...documents.user,
        createdAt: now,
        updatedAt: now,
      });
      transaction.create(facultyRef, {
        ...documents.faculty,
        createdAt: now,
        updatedAt: now,
      });
      transaction.create(employeeRef, { uid, createdAt: now });
    });
    await firebaseAdminApp.auth().updateUser(uid, { disabled: false });
    console.info('Admin created faculty account:', { adminUid: (req as FirebaseRequest).firebaseUser?.uid, uid });
    res.status(201).json({
      faculty: {
        uid,
        name: profile.name,
        email: profile.email,
        employeeId: profile.employeeId,
        department: profile.department,
        status: 'active',
        assignedSections: [],
      },
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
    if (code === 'EMPLOYEE_ID_EXISTS') {
      sendApiError(res, 409, 'EMPLOYEE_ID_EXISTS', 'A faculty account already uses this employee ID.');
      return;
    }
    if (code === 'FACULTY_PROFILE_EXISTS') {
      sendApiError(res, 409, 'FACULTY_PROFILE_EXISTS', 'This Firebase account already has an application profile.');
      return;
    }

    let cleanupFailed = false;
    if (createdUser) {
      try {
        await firestore.runTransaction(async (transaction) => {
          const [employeeSnapshot, userSnapshot, facultySnapshot] = await Promise.all([
            transaction.get(employeeRef),
            transaction.get(firestore.collection('users').doc(createdUser!.uid)),
            transaction.get(firestore.collection('faculty').doc(createdUser!.uid)),
          ]);
          if (employeeSnapshot.get('uid') === createdUser!.uid) transaction.delete(employeeRef);
          if (userSnapshot.exists && userSnapshot.get('role') === 'faculty') transaction.delete(userSnapshot.ref);
          if (facultySnapshot.exists) transaction.delete(facultySnapshot.ref);
        });
        await firebaseAdminApp.auth().deleteUser(createdUser.uid);
      } catch (cleanupError) {
        cleanupFailed = true;
        console.error('Faculty account cleanup failed:', {
          uid: createdUser.uid,
          code: cleanupError && typeof cleanupError === 'object' && 'code' in cleanupError ? String(cleanupError.code) : 'unknown',
        });
      }
    }
    console.error('Faculty account creation failed:', {
      uid: createdUser?.uid ?? null,
      code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown',
      cleanupFailed,
    });
    sendApiError(
      res,
      500,
      cleanupFailed ? 'FACULTY_CLEANUP_REQUIRED' : 'FACULTY_CREATE_FAILED',
      cleanupFailed
        ? 'Faculty provisioning failed and automatic cleanup was incomplete. Contact an administrator with the failed operation time; do not retry using this email until reviewed.'
        : 'Could not create the faculty account. No temporary password was saved.',
    );
  }
});

app.patch('/api/admin/faculty/:uid', verifyFirebaseToken, requireTrustedRole(['admin']), async (req, res) => {
  if (!firebaseAdminApp) {
    sendApiError(res, 503, 'ADMIN_SERVICE_UNAVAILABLE', 'Faculty management is unavailable.');
    return;
  }
  const uid = typeof req.params.uid === 'string' ? req.params.uid : '';
  const profile = normalizeFacultyProfileInput(req.body);
  if (!uid || uid.length > 128 || uid.includes('/') || !profile) {
    sendApiError(res, 400, 'INVALID_FACULTY_REQUEST', 'Provide a valid faculty UID, name, email, employee ID, and department.');
    return;
  }
  const firestore = firebaseAdminApp.firestore();
  const userRef = firestore.collection('users').doc(uid);
  const facultyRef = firestore.collection('faculty').doc(uid);
  let previousAuth: admin.auth.UserRecord;
  try {
    previousAuth = await firebaseAdminApp.auth().getUser(uid);
    const [existingUser, employeeProfiles, facultyUsers] = await Promise.all([
      userRef.get(),
      firestore.collection('faculty').get(),
      firestore.collection('users').where('role', '==', 'faculty').get(),
    ]);
    if (existingUser.get('role') !== 'faculty') {
      sendApiError(res, 404, 'FACULTY_NOT_FOUND', 'The faculty profile was not found.');
      return;
    }
    const previousEmail = previousAuth.email ?? '';
    const emailChanged = previousEmail.toLowerCase() !== profile.email;
    if (!previousEmail && emailChanged) throw new Error('FACULTY_EMAIL_NOT_SET');
    const duplicateEmployeeId = employeeProfiles.docs.some((document) =>
      document.id !== uid
      && normalizeEmployeeId(getString(document.get('employeeId'), 64)) === normalizeEmployeeId(profile.employeeId))
      || facultyUsers.docs.some((document) =>
        document.id !== uid
        && normalizeEmployeeId(getString(document.get('employeeId'), 64)) === normalizeEmployeeId(profile.employeeId));
    if (duplicateEmployeeId) {
      sendApiError(res, 409, 'EMPLOYEE_ID_EXISTS', 'A faculty account already uses this employee ID.');
      return;
    }
    if (emailChanged) await firebaseAdminApp.auth().updateUser(uid, { email: profile.email, displayName: profile.name });
    else await firebaseAdminApp.auth().updateUser(uid, { displayName: profile.name });

    try {
      const newEmployeeRef = firestore.collection('facultyEmployeeIds').doc(normalizeEmployeeId(profile.employeeId));
      await firestore.runTransaction(async (transaction) => {
        const [facultySnapshot, currentUserSnapshot] = await Promise.all([
          transaction.get(facultyRef),
          transaction.get(userRef),
        ]);
        const oldEmployeeId = getString(facultySnapshot.get('employeeId') ?? currentUserSnapshot.get('employeeId'), 64);
        const oldEmployeeRef = oldEmployeeId
          ? firestore.collection('facultyEmployeeIds').doc(normalizeEmployeeId(oldEmployeeId))
          : null;
        const refs = [newEmployeeRef, ...(oldEmployeeRef ? [oldEmployeeRef] : [])];
        const snapshots = await transaction.getAll(...refs);
        const newEmployeeSnapshot = snapshots[0];
        if (!currentUserSnapshot.exists || currentUserSnapshot.get('role') !== 'faculty') {
          throw new Error('FACULTY_NOT_FOUND');
        }
        if (newEmployeeSnapshot.exists && newEmployeeSnapshot.get('uid') !== uid) throw new Error('EMPLOYEE_ID_EXISTS');
        const now = admin.firestore.FieldValue.serverTimestamp();
        if (oldEmployeeRef && normalizeEmployeeId(oldEmployeeId) !== normalizeEmployeeId(profile.employeeId)) {
          const oldEmployeeSnapshot = snapshots[1];
          if (oldEmployeeSnapshot.get('uid') === uid) transaction.delete(oldEmployeeRef);
        }
        if (!newEmployeeSnapshot.exists) transaction.create(newEmployeeRef, { uid, createdAt: now });
        transaction.set(facultyRef, { ...profile, uid, authUserId: uid, updatedAt: now }, { merge: true });
        transaction.set(userRef, { name: profile.name, email: profile.email, employeeId: profile.employeeId, department: profile.department, updatedAt: now }, { merge: true });
      });
      res.json({ saved: true });
    } catch (error) {
      try {
        await firebaseAdminApp.auth().updateUser(uid, {
          email: previousEmail,
          displayName: previousAuth.displayName ?? '',
        });
      } catch (rollbackError) {
        console.error('Faculty Auth profile rollback failed:', {
          uid,
          code: rollbackError && typeof rollbackError === 'object' && 'code' in rollbackError ? String(rollbackError.code) : 'unknown',
        });
        throw new Error('FACULTY_AUTH_ROLLBACK_FAILED');
      }
      throw error;
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
    if (code === 'FACULTY_NOT_FOUND') {
      sendApiError(res, 404, 'FACULTY_NOT_FOUND', 'The faculty profile was not found.');
      return;
    }
    if (code === 'FACULTY_EMAIL_NOT_SET') {
      sendApiError(res, 409, 'FACULTY_EMAIL_NOT_SET', 'This faculty account has no Firebase email. Provision a verified email through the administrator account recovery process.');
      return;
    }
    if (code === 'EMPLOYEE_ID_EXISTS' || (error && typeof error === 'object' && 'code' in error && String(error.code) === 'auth/email-already-exists')) {
      sendApiError(res, 409, code === 'EMPLOYEE_ID_EXISTS' ? 'EMPLOYEE_ID_EXISTS' : 'FACULTY_EMAIL_EXISTS', code === 'EMPLOYEE_ID_EXISTS' ? 'A faculty account already uses this employee ID.' : 'A Firebase account already uses this email address.');
      return;
    }
    console.error('Faculty profile update failed:', { uid, code });
    sendApiError(res, 500, 'FACULTY_UPDATE_FAILED', 'Could not update the faculty profile. Verify the account before retrying.');
  }
});

app.patch('/api/admin/faculty/:uid/status', verifyFirebaseToken, requireTrustedRole(['admin']), async (req, res) => {
  if (!firebaseAdminApp) {
    sendApiError(res, 503, 'ADMIN_SERVICE_UNAVAILABLE', 'Faculty management is unavailable.');
    return;
  }
  const uid = typeof req.params.uid === 'string' ? req.params.uid : '';
  const status = req.body?.status;
  if (!uid || uid.length > 128 || uid.includes('/') || (status !== 'active' && status !== 'inactive')) {
    sendApiError(res, 400, 'INVALID_FACULTY_STATUS', 'A valid faculty UID and active/inactive status are required.');
    return;
  }
  const auth = firebaseAdminApp.auth();
  const firestore = firebaseAdminApp.firestore();
  const userRef = firestore.collection('users').doc(uid);
  const facultyRef = firestore.collection('faculty').doc(uid);
  let wasDisabled = false;
  let wasDisabledInProfile = false;
  let previousStatus: 'active' | 'inactive' = 'active';
  let authStatusChanged = false;
  let firestoreStatusSaved = false;
  try {
    const userSnapshot = await userRef.get();
    if (userSnapshot.get('role') !== 'faculty') {
      sendApiError(res, 404, 'FACULTY_NOT_FOUND', 'The faculty account was not found.');
      return;
    }
    previousStatus = isAccountActive(userSnapshot.data()) ? 'active' : 'inactive';
    wasDisabledInProfile = userSnapshot.get('disabled') === true;
    wasDisabled = (await auth.getUser(uid)).disabled;
    if (status === 'inactive') {
      await auth.updateUser(uid, { disabled: true });
      authStatusChanged = true;
    }
    await firestore.runTransaction(async (transaction) => {
      const currentUser = await transaction.get(userRef);
      if (currentUser.get('role') !== 'faculty') throw new Error('FACULTY_NOT_FOUND');
      const now = admin.firestore.FieldValue.serverTimestamp();
      transaction.set(userRef, { status, disabled: status === 'inactive', updatedAt: now }, { merge: true });
      transaction.set(facultyRef, { status, updatedAt: now }, { merge: true });
    });
    firestoreStatusSaved = true;
    if (status === 'active') {
      await auth.updateUser(uid, { disabled: false });
      authStatusChanged = true;
    }
    res.json({ saved: true, status });
  } catch (error) {
    const code = error instanceof Error ? error.message : error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
    try {
      if (firestoreStatusSaved) {
        await firestore.runTransaction(async (transaction) => {
          const now = admin.firestore.FieldValue.serverTimestamp();
          transaction.set(userRef, { status: previousStatus, disabled: wasDisabledInProfile, updatedAt: now }, { merge: true });
          transaction.set(facultyRef, { uid, status: previousStatus, updatedAt: now }, { merge: true });
        });
      }
      if (authStatusChanged) await auth.updateUser(uid, { disabled: wasDisabled });
    } catch (rollbackError) {
      console.error('Faculty status rollback failed:', {
        uid,
        code: rollbackError && typeof rollbackError === 'object' && 'code' in rollbackError ? String(rollbackError.code) : 'unknown',
      });
    }
    if (code === 'FACULTY_NOT_FOUND') {
      sendApiError(res, 404, 'FACULTY_NOT_FOUND', 'The faculty account was not found.');
      return;
    }
    console.error('Faculty status update failed:', { uid, code });
    sendApiError(res, 500, 'FACULTY_STATUS_UPDATE_FAILED', 'Could not update faculty access status. Verify the account before retrying.');
  }
});

app.put('/api/admin/faculty/:uid/sections', verifyFirebaseToken, requireTrustedRole(['admin']), async (req, res) => {
  if (!firebaseAdminApp) {
    sendApiError(res, 503, 'ADMIN_SERVICE_UNAVAILABLE', 'Faculty management is unavailable.');
    return;
  }
  const uid = typeof req.params.uid === 'string' ? req.params.uid : '';
  const desiredIds = normalizeSectionIds(req.body?.sectionIds);
  if (!uid || uid.length > 128 || uid.includes('/') || !desiredIds) {
    sendApiError(res, 400, 'INVALID_FACULTY_ASSIGNMENTS', 'Provide a valid faculty UID and up to 300 course section IDs.');
    return;
  }
  const firestore = firebaseAdminApp.firestore();
  const facultyRef = firestore.collection('faculty').doc(uid);
  const userRef = firestore.collection('users').doc(uid);
  try {
    const facultySnapshot = await facultyRef.get();
    const facultyData = facultySnapshot.data() ?? {};
    if (!isAccountActive(facultyData)) {
      sendApiError(res, 404, 'FACULTY_NOT_FOUND', 'An active faculty profile is required for course assignment.');
      return;
    }
    const userSnapshot = await userRef.get();
    if (userSnapshot.get('role') !== 'faculty' || !isAccountActive(userSnapshot.data())) {
      sendApiError(res, 404, 'FACULTY_NOT_FOUND', 'An active faculty profile is required for course assignment.');
      return;
    }
    const currentSections = await firestore.collection('courseSections').where('assignedFacultyUid', '==', uid).get();
    const currentIds = currentSections.docs.map((document) => document.id);
    const allIds = [...new Set([...currentIds, ...desiredIds])];
    if (allIds.length > 300) {
      sendApiError(res, 400, 'TOO_MANY_ASSIGNMENTS', 'Update this faculty member in batches of no more than 300 course sections.');
      return;
    }
    const sectionRefs = allIds.map((sectionId) => firestore.collection('courseSections').doc(sectionId));
    const profileName = getString(facultySnapshot.get('name') ?? userSnapshot.get('name'), 120);
    const profileEmail = getString(facultySnapshot.get('email') ?? userSnapshot.get('email'), 320).toLowerCase();
    await firestore.runTransaction(async (transaction) => {
      const snapshots = await transaction.getAll(userRef, facultyRef, ...sectionRefs);
      if (snapshots[0].get('role') !== 'faculty' || !isAccountActive(snapshots[1].data())) {
        throw new Error('FACULTY_NOT_FOUND');
      }
      const sectionSnapshots = snapshots.slice(2);
      const missing = sectionSnapshots.find((snapshot, index) => desiredIds.includes(allIds[index]) && !snapshot.exists);
      if (missing) throw new Error('SECTION_NOT_FOUND');
      const desired = new Set(desiredIds);
      sectionSnapshots.forEach((snapshot, index) => {
        const sectionId = allIds[index];
        if (desired.has(sectionId)) {
          transaction.set(sectionRefs[index], {
            assignedFacultyUid: uid,
            faculty: profileName,
            facultyEmail: profileEmail,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        } else if (currentIds.includes(sectionId) && snapshot.get('assignedFacultyUid') === uid) {
          transaction.update(sectionRefs[index], {
            assignedFacultyUid: admin.firestore.FieldValue.delete(),
            faculty: '',
            facultyEmail: '',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      });

      app.get('/api/admin/college', verifyFirebaseToken, requireTrustedRole(['admin']), async (_req, res) => {
        if (!firebaseAdminApp) {
          sendApiError(res, 503, 'ADMIN_SERVICE_UNAVAILABLE', 'College management is unavailable.');
          return;
        }
        try {
          const firestore = firebaseAdminApp.firestore();
          const [departments, academicYears, subjects, sections, students, studentUsers] = await Promise.all([
            firestore.collection('departments').get(),
            firestore.collection('academicYears').get(),
            firestore.collection('subjects').get(),
            firestore.collection('courseSections').get(),
            firestore.collection('students').get(),
            firestore.collection('users').where('role', '==', 'student').get(),
          ]);
          const usersByUid = new Map(studentUsers.docs.map((document) => [document.id, document.data()]));
          res.json({
            departments: departments.docs.map((document) => ({ ...document.data(), id: document.id })),
            academicYears: academicYears.docs.map((document) => ({ ...document.data(), id: document.id })),
            subjects: subjects.docs.map((document) => ({ ...document.data(), id: document.id })),
            sections: sections.docs.map(normalizeAcademicSection),
            students: students.docs.map((document) => {
              const profile = document.data();
              const user = usersByUid.get(document.id) ?? {};
              return {
                uid: document.id,
                studentId: getString(profile.studentId ?? profile.rollNo, 64),
                name: getString(profile.name ?? user.name, 120),
                email: getString(profile.email ?? user.email, 320).toLowerCase(),
                departmentId: getString(profile.departmentId, 128),
                btechYear: Number.isInteger(profile.btechYear) ? profile.btechYear : null,
                sectionId: getString(profile.sectionId, 128),
                semester: Number.isInteger(profile.semester) ? profile.semester : null,
                enrollmentStatus: profile.enrollmentStatus === 'inactive' ? 'inactive' : profile.enrollmentStatus === 'active' ? 'active' : 'pending',
              };
            }),
          });
        } catch (error) {
          console.error('College management data lookup failed:', error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown');
          sendApiError(res, 500, 'COLLEGE_DATA_FAILED', 'Could not load college management data.');
        }
      });

      app.get('/api/admin/reports', verifyFirebaseToken, requireTrustedRole(['admin']), async (_req, res) => {
        if (!firebaseAdminApp) {
          sendApiError(res, 503, 'ADMIN_SERVICE_UNAVAILABLE', 'College reports are unavailable.');
          return;
        }
        try {
          const firestore = firebaseAdminApp.firestore();
          const [sections, students, faculty, departments] = await Promise.all([
            firestore.collection('courseSections').get(),
            firestore.collection('students').get(),
            firestore.collection('users').where('role', '==', 'faculty').get(),
            firestore.collection('departments').get(),
          ]);
          const sectionReports = sections.docs.map((document) => {
            const section = document.data();
            const roster = Array.isArray(section.students) ? section.students.filter(isDataRecord) : [];
            const averages = roster.flatMap((student) => {
              const marks = isDataRecord(student.marks) ? Object.values(student.marks) : [];
              const numeric = marks.filter((mark): mark is number => typeof mark === 'number' && Number.isFinite(mark) && mark >= 0);
              return numeric.length ? [average(numeric)] : [];
            });
            const attendance = roster.flatMap((student) =>
              typeof student.attendance === 'number' && Number.isFinite(student.attendance) ? [student.attendance] : []);
            return {
              sectionId: document.id,
              code: getString(section.code, 80),
              course: getString(section.course, 160),
              departmentId: getString(section.departmentId, 128),
              btechYear: Number.isInteger(section.btechYear) ? section.btechYear : null,
              semester: Number.isInteger(section.semester) ? section.semester : null,
              studentCount: Array.isArray(section.enrolledStudentUids) ? section.enrolledStudentUids.length : roster.length,
              studentsWithMarks: averages.length,
              averagePercentage: averages.length ? average(averages) : null,
              attendanceAverage: attendance.length ? average(attendance) : null,
              assignedFacultyUid: getString(section.assignedFacultyUid, 128) || null,
            };
          });
          res.json({
            totals: {
              departments: departments.size,
              faculty: faculty.size,
              students: students.size,
              sections: sections.size,
            },
            sections: sectionReports,
          });
        } catch (error) {
          console.error('College academic report failed:', error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown');
          sendApiError(res, 500, 'COLLEGE_REPORT_FAILED', 'Could not load college academic reports.');
        }
      });

      app.post('/api/admin/departments', verifyFirebaseToken, requireTrustedRole(['admin']), async (req, res) => {
        if (!firebaseAdminApp) {
          sendApiError(res, 503, 'ADMIN_SERVICE_UNAVAILABLE', 'Department management is unavailable.');
          return;
        }
        const department = normalizeDepartmentInput(req.body);
        if (!department) {
          sendApiError(res, 400, 'INVALID_DEPARTMENT', 'Provide a department name and an alphanumeric department code.');
          return;
        }
        const firestore = firebaseAdminApp.firestore();
        const departmentId = department.code.toLowerCase();
        const reference = firestore.collection('departments').doc(departmentId);
        try {
          await firestore.runTransaction(async (transaction) => {
            const existing = await transaction.get(reference);
            if (existing.exists) throw new Error('DEPARTMENT_EXISTS');
            transaction.create(reference, {
              ...department,
              status: 'active',
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          });
          res.status(201).json({ id: departmentId, ...department, status: 'active' });
        } catch (error) {
          if (error instanceof Error && error.message === 'DEPARTMENT_EXISTS') {
            sendApiError(res, 409, 'DEPARTMENT_EXISTS', 'A department with this code already exists.');
            return;
          }
          console.error('Department creation failed:', error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown');
          sendApiError(res, 500, 'DEPARTMENT_CREATE_FAILED', 'Could not create the department.');
        }
      });

      app.patch('/api/admin/departments/:departmentId', verifyFirebaseToken, requireTrustedRole(['admin']), async (req, res) => {
        if (!firebaseAdminApp) {
          sendApiError(res, 503, 'ADMIN_SERVICE_UNAVAILABLE', 'Department management is unavailable.');
          return;
        }
        const departmentId = typeof req.params.departmentId === 'string' ? req.params.departmentId : '';
        const name = getString(req.body?.name, 120);
        const status = req.body?.status;
        if (!isValidDocumentId(departmentId) || !name || (status !== 'active' && status !== 'inactive')) {
          sendApiError(res, 400, 'INVALID_DEPARTMENT', 'Provide a valid department name and active/inactive status.');
          return;
        }
        try {
          const reference = firebaseAdminApp.firestore().collection('departments').doc(departmentId);
          await firebaseAdminApp.firestore().runTransaction(async (transaction) => {
            const existing = await transaction.get(reference);
            if (!existing.exists) throw new Error('DEPARTMENT_NOT_FOUND');
            transaction.update(reference, { name, status, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          });
          res.json({ saved: true });
        } catch (error) {
          if (error instanceof Error && error.message === 'DEPARTMENT_NOT_FOUND') {
            sendApiError(res, 404, 'DEPARTMENT_NOT_FOUND', 'Department was not found.');
            return;
          }
          console.error('Department update failed:', error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown');
          sendApiError(res, 500, 'DEPARTMENT_UPDATE_FAILED', 'Could not update the department.');
        }
      });

      app.post('/api/admin/academic-years', verifyFirebaseToken, requireTrustedRole(['admin']), async (req, res) => {
        if (!firebaseAdminApp) {
          sendApiError(res, 503, 'ADMIN_SERVICE_UNAVAILABLE', 'Academic year management is unavailable.');
          return;
        }
        const departmentId = getString(req.body?.departmentId, 128);
        const btechYear = Number(req.body?.btechYear);
        const semester = Number(req.body?.semester);
        const label = getString(req.body?.label, 80);
        if (!isValidDocumentId(departmentId) || !Number.isInteger(btechYear) || btechYear < 1 || btechYear > 4
          || !Number.isInteger(semester) || semester < 1 || semester > 8 || !label) {
          sendApiError(res, 400, 'INVALID_ACADEMIC_YEAR', 'Provide a department, B.Tech year 1–4, semester 1–8, and label.');
          return;
        }
        const firestore = firebaseAdminApp.firestore();
        const departmentRef = firestore.collection('departments').doc(departmentId);
        const yearId = `${departmentId}_y${btechYear}_s${semester}`;
        const yearRef = firestore.collection('academicYears').doc(yearId);
        try {
          await firestore.runTransaction(async (transaction) => {
            const [department, existing] = await Promise.all([
              transaction.get(departmentRef),
              transaction.get(yearRef),
            ]);
            if (!department.exists || department.get('status') === 'inactive') throw new Error('DEPARTMENT_UNAVAILABLE');
            if (existing.exists) throw new Error('ACADEMIC_YEAR_EXISTS');
            transaction.create(yearRef, {
              id: yearId,
              departmentId,
              btechYear,
              semester,
              label,
              status: 'active',
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          });
          res.status(201).json({ id: yearId, departmentId, btechYear, semester, label, status: 'active' });
        } catch (error) {
          if (error instanceof Error && error.message === 'ACADEMIC_YEAR_EXISTS') {
            sendApiError(res, 409, 'ACADEMIC_YEAR_EXISTS', 'This B.Tech year and semester already exist for the department.');
            return;
          }
          if (error instanceof Error && error.message === 'DEPARTMENT_UNAVAILABLE') {
            sendApiError(res, 404, 'DEPARTMENT_NOT_FOUND', 'An active department is required.');
            return;
          }
          console.error('Academic year creation failed:', error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown');
          sendApiError(res, 500, 'ACADEMIC_YEAR_CREATE_FAILED', 'Could not create the academic year.');
        }
      });

      app.post('/api/admin/classes', verifyFirebaseToken, requireTrustedRole(['admin']), async (req, res) => {
        if (!firebaseAdminApp) {
          sendApiError(res, 503, 'ADMIN_SERVICE_UNAVAILABLE', 'Class management is unavailable.');
          return;
        }
        const code = getString(req.body?.code, 80).toUpperCase();
        const name = getString(req.body?.name, 120);
        const course = getString(req.body?.course, 160);
        const departmentId = getString(req.body?.departmentId, 128);
        const sectionName = getString(req.body?.section, 32).toUpperCase();
        const btechYear = Number(req.body?.btechYear);
        const semester = Number(req.body?.semester);
        const facultyUid = getString(req.body?.facultyUid, 128);
        const id = getString(req.body?.id, 128) || `${departmentId}-y${btechYear}-${sectionName.toLowerCase()}`;
        if (!code || !name || !course || !isValidDocumentId(departmentId) || !isValidDocumentId(id)
          || !/^[A-Z0-9_-]+$/.test(sectionName) || !Number.isInteger(btechYear) || btechYear < 1 || btechYear > 4
          || !Number.isInteger(semester) || semester < 1 || semester > 8
          || (facultyUid && !isValidDocumentId(facultyUid))) {
          sendApiError(res, 400, 'INVALID_CLASS', 'Provide valid class, department, B.Tech year, semester and optional faculty details.');
          return;
        }
        const firestore = firebaseAdminApp.firestore();
        const departmentRef = firestore.collection('departments').doc(departmentId);
        const sectionRef = firestore.collection('courseSections').doc(id);
        const yearRef = firestore.collection('academicYears').doc(`${departmentId}_y${btechYear}_s${semester}`);
        const facultyUserRef = facultyUid ? firestore.collection('users').doc(facultyUid) : null;
        const facultyRef = facultyUid ? firestore.collection('faculty').doc(facultyUid) : null;
        try {
          await firestore.runTransaction(async (transaction) => {
            const refs = [departmentRef, sectionRef, yearRef, ...(facultyUserRef && facultyRef ? [facultyUserRef, facultyRef] : [])];
            const snapshots = await transaction.getAll(...refs);
            if (!snapshots[0].exists || snapshots[0].get('status') === 'inactive') throw new Error('DEPARTMENT_UNAVAILABLE');
            if (snapshots[1].exists) throw new Error('CLASS_EXISTS');
            if (facultyUid && (
              snapshots[3].get('role') !== 'faculty'
              || !isAccountActive(snapshots[3].data())
              || !snapshots[4].exists
              || !isAccountActive(snapshots[4].data())
            )) throw new Error('FACULTY_UNAVAILABLE');
            const now = admin.firestore.FieldValue.serverTimestamp();
            if (!snapshots[2].exists) {
              transaction.create(yearRef, {
                id: yearRef.id,
                departmentId,
                btechYear,
                semester,
                label: `B.Tech Year ${btechYear} · Semester ${semester}`,
                status: 'active',
                createdAt: now,
              });
            }
            const facultyProfile = facultyUid ? snapshots[4]?.data() ?? {} : {};
            transaction.create(sectionRef, {
              id,
              code,
              name: `${name} · Section ${sectionName}`,
              course,
              term: `B.Tech Year ${btechYear} · Semester ${semester}`,
              departmentId,
              btechYear,
              semester,
              section: sectionName,
              faculty: getString(facultyProfile.name, 120),
              facultyEmail: getString(facultyProfile.email, 320),
              subjects: [],
              students: [],
              enrolledStudentUids: [],
              materials: [],
              ...(facultyUid ? { assignedFacultyUid: facultyUid } : {}),
              createdAt: now,
              updatedAt: now,
            });
          });
          res.status(201).json({ id, code, name, departmentId, btechYear, semester, section: sectionName });
        } catch (error) {
          const code = error instanceof Error ? error.message : '';
          if (code === 'CLASS_EXISTS') {
            sendApiError(res, 409, 'CLASS_EXISTS', 'A class with this ID already exists.');
            return;
          }
          if (code === 'DEPARTMENT_UNAVAILABLE') {
            sendApiError(res, 404, 'DEPARTMENT_NOT_FOUND', 'An active department is required.');
            return;
          }
          if (code === 'FACULTY_UNAVAILABLE') {
            sendApiError(res, 404, 'FACULTY_NOT_FOUND', 'An active faculty profile is required for assignment.');
            return;
          }
          console.error('Academic class creation failed:', error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown');
          sendApiError(res, 500, 'CLASS_CREATE_FAILED', 'Could not create the academic class.');
        }
      });

      app.patch('/api/admin/classes/:sectionId', verifyFirebaseToken, requireTrustedRole(['admin']), async (req, res) => {
        if (!firebaseAdminApp) {
          sendApiError(res, 503, 'ADMIN_SERVICE_UNAVAILABLE', 'Class management is unavailable.');
          return;
        }
        const sectionId = typeof req.params.sectionId === 'string' ? req.params.sectionId : '';
        const name = getString(req.body?.name, 120);
        const facultyUid = req.body?.facultyUid === null || req.body?.facultyUid === ''
          ? ''
          : getString(req.body?.facultyUid, 128);
        const status = req.body?.status;
        if (!isValidDocumentId(sectionId) || !name
          || (facultyUid && !isValidDocumentId(facultyUid))
          || (status !== 'active' && status !== 'inactive')) {
          sendApiError(res, 400, 'INVALID_CLASS_UPDATE', 'Provide a valid class name, optional faculty UID, and active/inactive status.');
          return;
        }
        const firestore = firebaseAdminApp.firestore();
        const sectionRef = firestore.collection('courseSections').doc(sectionId);
        const facultyUserRef = facultyUid ? firestore.collection('users').doc(facultyUid) : null;
        const facultyRef = facultyUid ? firestore.collection('faculty').doc(facultyUid) : null;
        try {
          await firestore.runTransaction(async (transaction) => {
            const refs = [sectionRef, ...(facultyUserRef && facultyRef ? [facultyUserRef, facultyRef] : [])];
            const snapshots = await transaction.getAll(...refs);
            if (!snapshots[0].exists) throw new Error('CLASS_NOT_FOUND');
            if (facultyUid && (
              snapshots[1].get('role') !== 'faculty'
              || !isAccountActive(snapshots[1].data())
              || !snapshots[2].exists
              || !isAccountActive(snapshots[2].data())
            )) throw new Error('FACULTY_UNAVAILABLE');
            const faculty = facultyUid ? snapshots[2].data() ?? {} : {};
            transaction.update(sectionRef, {
              name,
              status,
              ...(facultyUid
                ? {
                  assignedFacultyUid: facultyUid,
                  faculty: getString(faculty.name, 120),
                  facultyEmail: getString(faculty.email, 320).toLowerCase(),
                }
                : {
                  assignedFacultyUid: admin.firestore.FieldValue.delete(),
                  faculty: '',
                  facultyEmail: '',
                }),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          });
          res.json({ saved: true });
        } catch (error) {
          const code = error instanceof Error ? error.message : '';
          if (code === 'CLASS_NOT_FOUND') {
            sendApiError(res, 404, 'CLASS_NOT_FOUND', 'Academic class was not found.');
            return;
          }
          if (code === 'FACULTY_UNAVAILABLE') {
            sendApiError(res, 404, 'FACULTY_NOT_FOUND', 'An active faculty profile is required for assignment.');
            return;
          }
          console.error('Academic class update failed:', error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown');
          sendApiError(res, 500, 'CLASS_UPDATE_FAILED', 'Could not update the academic class.');
        }
      });

      app.post('/api/admin/subjects', verifyFirebaseToken, requireTrustedRole(['admin']), async (req, res) => {
        if (!firebaseAdminApp) {
          sendApiError(res, 503, 'ADMIN_SERVICE_UNAVAILABLE', 'Subject management is unavailable.');
          return;
        }
        const subject = normalizeSubjectInput(req.body);
        if (!subject) {
          sendApiError(res, 400, 'INVALID_SUBJECT', 'Provide a valid subject code/name, department, assigned faculty, and one or more sections.');
          return;
        }
        const firestore = firebaseAdminApp.firestore();
        const id = `${subject.departmentId}_${subject.code.toLowerCase()}`;
        const subjectRef = firestore.collection('subjects').doc(id);
        const departmentRef = firestore.collection('departments').doc(subject.departmentId);
        const facultyUserRef = firestore.collection('users').doc(subject.facultyUid);
        const facultyRef = firestore.collection('faculty').doc(subject.facultyUid);
        const sectionRefs = subject.sectionIds.map((sectionId) => firestore.collection('courseSections').doc(sectionId));
        try {
          await firestore.runTransaction(async (transaction) => {
            const refs = [subjectRef, departmentRef, facultyUserRef, facultyRef, ...sectionRefs];
            const snapshots = await transaction.getAll(...refs);
            if (snapshots[0].exists) throw new Error('SUBJECT_EXISTS');
            if (!snapshots[1].exists || snapshots[1].get('status') === 'inactive') throw new Error('DEPARTMENT_UNAVAILABLE');
            if (snapshots[2].get('role') !== 'faculty' || !isAccountActive(snapshots[2].data()) || !snapshots[3].exists || !isAccountActive(snapshots[3].data())) {
              throw new Error('FACULTY_UNAVAILABLE');
            }
            const sectionSnapshots = snapshots.slice(4);
            if (sectionSnapshots.some((section) => !section.exists || section.get('status') === 'inactive' || section.get('departmentId') !== subject.departmentId)) {
              throw new Error('SECTION_UNAVAILABLE');
            }
            const subjectName = subject.name;
            transaction.create(subjectRef, {
              ...subject,
              id,
              status: 'active',
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            sectionSnapshots.forEach((sectionSnapshot, index) => {
              const existingSubjects = Array.isArray(sectionSnapshot.get('subjects'))
                ? sectionSnapshot.get('subjects').filter((name: unknown): name is string => typeof name === 'string')
                : [];
              transaction.update(sectionRefs[index], {
                subjects: [...new Set([...existingSubjects, subjectName])],
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            });
          });
          res.status(201).json({ id, ...subject, status: 'active' });
        } catch (error) {
          const code = error instanceof Error ? error.message : '';
          if (code === 'SUBJECT_EXISTS') {
            sendApiError(res, 409, 'SUBJECT_EXISTS', 'A subject with this code already exists in the department.');
            return;
          }
          if (code === 'DEPARTMENT_UNAVAILABLE') {
            sendApiError(res, 404, 'DEPARTMENT_NOT_FOUND', 'An active department is required.');
            return;
          }
          if (code === 'FACULTY_UNAVAILABLE') {
            sendApiError(res, 404, 'FACULTY_NOT_FOUND', 'An active faculty account is required for subject assignment.');
            return;
          }
          if (code === 'SECTION_UNAVAILABLE') {
            sendApiError(res, 404, 'SECTION_NOT_FOUND', 'All selected classes must exist in the selected department.');
            return;
          }
          console.error('Subject creation failed:', error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown');
          sendApiError(res, 500, 'SUBJECT_CREATE_FAILED', 'Could not create the subject.');
        }
      });

      app.post('/api/admin/students', verifyFirebaseToken, requireTrustedRole(['admin']), async (req, res) => {
        if (!firebaseAdminApp) {
          sendApiError(res, 503, 'ADMIN_SERVICE_UNAVAILABLE', 'Student management is unavailable.');
          return;
        }
        const name = getString(req.body?.name, 120);
        const email = getString(req.body?.email, 320).toLowerCase();
        const temporaryPassword = typeof req.body?.temporaryPassword === 'string' ? req.body.temporaryPassword : '';
        const academic = normalizeStudentAcademicInput(req.body?.academic);
        if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || temporaryPassword.length < 12 || temporaryPassword.length > 128 || !academic) {
          sendApiError(res, 400, 'INVALID_STUDENT_REQUEST', 'Provide valid identity details, academic assignment, and a temporary password of 12–128 characters.');
          return;
        }
        const firestore = firebaseAdminApp.firestore();
        const auth = firebaseAdminApp.auth();
        const departmentRef = firestore.collection('departments').doc(academic.departmentId);
        const sectionRef = firestore.collection('courseSections').doc(academic.sectionId);
        const studentIdRef = firestore.collection('studentIds').doc(academic.studentId.toLowerCase());
        let createdUser: admin.auth.UserRecord | null = null;
        try {
          const [department, section, studentId] = await Promise.all([departmentRef.get(), sectionRef.get(), studentIdRef.get()]);
          if (!department.exists || department.get('status') === 'inactive') {
            sendApiError(res, 404, 'DEPARTMENT_NOT_FOUND', 'An active department is required for student enrollment.');
            return;
          }
          if (!section.exists || section.get('departmentId') !== academic.departmentId
            || section.get('status') === 'inactive'
            || section.get('btechYear') !== academic.btechYear || section.get('semester') !== academic.semester) {
            sendApiError(res, 404, 'CLASS_NOT_FOUND', 'The selected class must match the student department, year, and semester.');
            return;
          }
          if (studentId.exists) {
            sendApiError(res, 409, 'STUDENT_ID_EXISTS', 'This student ID is already assigned.');
            return;
          }
          createdUser = await auth.createUser({
            email,
            password: temporaryPassword,
            displayName: name,
            disabled: true,
            emailVerified: false,
          });
          const uid = createdUser.uid;
          const userRef = firestore.collection('users').doc(uid);
          const profileRef = firestore.collection('students').doc(uid);
          await firestore.runTransaction(async (transaction) => {
            const [user, profile, index, sectionSnapshot] = await Promise.all([
              transaction.get(userRef),
              transaction.get(profileRef),
              transaction.get(studentIdRef),
              transaction.get(sectionRef),
            ]);
            if (user.exists || profile.exists) throw new Error('STUDENT_PROFILE_EXISTS');
            if (index.exists) throw new Error('STUDENT_ID_EXISTS');
            if (!sectionSnapshot.exists) throw new Error('CLASS_NOT_FOUND');
            const now = admin.firestore.FieldValue.serverTimestamp();
            const enrolledStudentUids = Array.isArray(sectionSnapshot.get('enrolledStudentUids'))
              ? sectionSnapshot.get('enrolledStudentUids').filter((value: unknown): value is string => typeof value === 'string')
              : [];
            const roster = Array.isArray(sectionSnapshot.get('students'))
              ? (sectionSnapshot.get('students') as unknown[]).filter(isDataRecord)
              : [];
            transaction.create(userRef, {
              uid,
              role: 'student',
              status: academic.enrollmentStatus,
              name,
              email,
              studentId: academic.studentId,
              rollNo: academic.studentId,
              departmentId: academic.departmentId,
              btechYear: academic.btechYear,
              sectionId: academic.sectionId,
              semester: academic.semester,
              updatedAt: now,
            });
            transaction.create(profileRef, {
              id: uid,
              studentId: academic.studentId,
              rollNo: academic.studentId,
              authUserId: uid,
              name,
              email,
              departmentId: academic.departmentId,
              btechYear: academic.btechYear,
              sectionId: academic.sectionId,
              semester: academic.semester,
              enrollmentStatus: academic.enrollmentStatus,
              enrollmentSectionIds: [academic.sectionId],
              updatedAt: now,
            });
            transaction.create(studentIdRef, { uid, studentId: academic.studentId, createdAt: now });
            transaction.update(sectionRef, {
              enrolledStudentUids: [...new Set([...enrolledStudentUids, uid])],
              students: [...roster.filter((student) => student.id !== uid), {
                id: uid,
                name,
                rollNo: academic.studentId,
                email,
                marks: {},
              }],
              updatedAt: now,
            });
          });
          await auth.updateUser(uid, { disabled: academic.enrollmentStatus !== 'active' });
          res.status(201).json({ uid, studentId: academic.studentId, enrollmentStatus: academic.enrollmentStatus });
        } catch (error) {
          const code = error instanceof Error ? error.message : error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
          if (createdUser) {
            try {
              await auth.deleteUser(createdUser.uid);
            } catch (cleanupError) {
              console.error('Student provisioning Auth cleanup failed:', cleanupError && typeof cleanupError === 'object' && 'code' in cleanupError ? String(cleanupError.code) : 'unknown');
            }
          }
          if (code === 'STUDENT_ID_EXISTS') {
            sendApiError(res, 409, 'STUDENT_ID_EXISTS', 'This student ID is already assigned.');
            return;
          }
          if (code === 'CLASS_NOT_FOUND') {
            sendApiError(res, 404, 'CLASS_NOT_FOUND', 'The selected class is no longer available.');
            return;
          }
          if (code === 'STUDENT_PROFILE_EXISTS') {
            sendApiError(res, 409, 'STUDENT_PROFILE_EXISTS', 'A Student profile already exists for this Firebase UID.');
            return;
          }
          console.error('Student provisioning failed:', { code });
          sendApiError(res, 500, 'STUDENT_CREATE_FAILED', 'Could not create the student account and academic profile.');
        }
      });

      app.patch('/api/admin/students/:uid', verifyFirebaseToken, requireTrustedRole(['admin']), async (req, res) => {
        if (!firebaseAdminApp) {
          sendApiError(res, 503, 'ADMIN_SERVICE_UNAVAILABLE', 'Student management is unavailable.');
          return;
        }
        const uid = typeof req.params.uid === 'string' ? req.params.uid : '';
        const name = getString(req.body?.name, 120);
        const academic = normalizeStudentAcademicInput(req.body?.academic);
        if (!isValidDocumentId(uid) || !name || !academic) {
          sendApiError(res, 400, 'INVALID_STUDENT_UPDATE', 'Provide a valid student UID, name, and complete academic assignment.');
          return;
        }
        const firestore = firebaseAdminApp.firestore();
        const auth = firebaseAdminApp.auth();
        const userRef = firestore.collection('users').doc(uid);
        const profileRef = firestore.collection('students').doc(uid);
        const newSectionRef = firestore.collection('courseSections').doc(academic.sectionId);
        const departmentRef = firestore.collection('departments').doc(academic.departmentId);
        const studentIdRef = firestore.collection('studentIds').doc(academic.studentId.toLowerCase());
        let wasDisabled = false;
        let authDisabledBeforeTransaction = false;
        let firestoreCommitted = false;
        try {
          const [existingProfile, department, targetSection] = await Promise.all([
            profileRef.get(),
            firestore.collection('departments').doc(academic.departmentId).get(),
            newSectionRef.get(),
          ]);
          if (!existingProfile.exists || existingProfile.get('authUserId') !== uid) {
            sendApiError(res, 404, 'STUDENT_NOT_FOUND', 'A linked student profile is required.');
            return;
          }
          if (!department.exists || department.get('status') === 'inactive'
            || !targetSection.exists || targetSection.get('departmentId') !== academic.departmentId
            || targetSection.get('status') === 'inactive'
            || targetSection.get('btechYear') !== academic.btechYear || targetSection.get('semester') !== academic.semester) {
            sendApiError(res, 404, 'CLASS_NOT_FOUND', 'Choose an active class matching the selected department, year, and semester.');
            return;
          }
          const oldStudentId = getString(existingProfile.get('studentId') ?? existingProfile.get('rollNo'), 64);
          const oldSectionId = getString(existingProfile.get('sectionId'), 128);
          const oldSectionRef = oldSectionId ? firestore.collection('courseSections').doc(oldSectionId) : null;
          const oldStudentIdRef = oldStudentId ? firestore.collection('studentIds').doc(oldStudentId.toLowerCase()) : null;
          const currentAuthUser = await auth.getUser(uid);
          wasDisabled = currentAuthUser.disabled;
          if (academic.enrollmentStatus === 'inactive' && !wasDisabled) {
            await auth.updateUser(uid, { disabled: true });
            authDisabledBeforeTransaction = true;
          }

          await firestore.runTransaction(async (transaction) => {
            const refs = [
              userRef,
              profileRef,
              studentIdRef,
              newSectionRef,
              ...(oldSectionRef ? [oldSectionRef] : []),
              ...(oldStudentIdRef && oldStudentIdRef.path !== studentIdRef.path ? [oldStudentIdRef] : []),
              departmentRef,
            ];
            const snapshots = await transaction.getAll(...refs);
            const [userSnapshot, profileSnapshot, newIndexSnapshot, targetSnapshot] = snapshots;
            if (!userSnapshot.exists || userSnapshot.get('role') !== 'student'
              || !profileSnapshot.exists || profileSnapshot.get('authUserId') !== uid) throw new Error('STUDENT_NOT_FOUND');
            if (newIndexSnapshot.exists && newIndexSnapshot.get('uid') !== uid) throw new Error('STUDENT_ID_EXISTS');
            const departmentSnapshot = snapshots[snapshots.length - 1];
            if (!targetSnapshot.exists || targetSnapshot.get('status') === 'inactive'
              || targetSnapshot.get('departmentId') !== academic.departmentId
              || targetSnapshot.get('btechYear') !== academic.btechYear
              || targetSnapshot.get('semester') !== academic.semester
              || !departmentSnapshot.exists || departmentSnapshot.get('status') === 'inactive') {
              throw new Error('CLASS_NOT_FOUND');
            }
            const now = admin.firestore.FieldValue.serverTimestamp();
            const profile = profileSnapshot.data() ?? {};
            const oldSectionPosition = oldSectionRef ? 4 : -1;
            const oldIndexPosition = oldStudentIdRef && oldStudentIdRef.path !== studentIdRef.path
              ? 4 + Number(Boolean(oldSectionRef))
              : -1;
            const oldStudentIdSnapshot = oldIndexPosition >= 0 ? snapshots[oldIndexPosition] : null;
            if (oldStudentIdSnapshot?.exists && oldStudentIdSnapshot.get('uid') !== uid) {
              throw new Error('STUDENT_ID_INDEX_CONFLICT');
            }
            if (oldSectionRef && oldSectionRef.path !== newSectionRef.path) {
              const oldSection = snapshots[oldSectionPosition];
              const previousUids = Array.isArray(oldSection.get('enrolledStudentUids'))
                  ? (oldSection.get('enrolledStudentUids') as unknown[]).filter((value): value is string => typeof value === 'string')
                : [];
              const previousRoster = Array.isArray(oldSection.get('students'))
                  ? (oldSection.get('students') as unknown[]).filter(isDataRecord)
                : [];
              transaction.update(oldSectionRef, {
                  enrolledStudentUids: previousUids.filter((studentUid: string) => studentUid !== uid),
                  students: previousRoster.filter((student: DataRecord) => student.id !== uid),
                updatedAt: now,
              });
            }

            const targetIsOldSection = oldSectionRef?.path === newSectionRef.path;
            const targetSnapshotIndex = targetIsOldSection ? oldSectionPosition : 3;
            const targetRosterDocument = snapshots[targetSnapshotIndex];
            const targetUids = Array.isArray(targetRosterDocument.get('enrolledStudentUids'))
              ? (targetRosterDocument.get('enrolledStudentUids') as unknown[]).filter((value): value is string => typeof value === 'string')
              : [];
            const targetRoster = Array.isArray(targetRosterDocument.get('students'))
              ? (targetRosterDocument.get('students') as unknown[]).filter(isDataRecord)
              : [];
            const priorRosterEntry = targetRoster.find((student: DataRecord) => student.id === uid);
            const studentEntry = {
              ...(priorRosterEntry ?? {}),
              id: uid,
              name,
              rollNo: academic.studentId,
              email: getString(userSnapshot.get('email'), 320).toLowerCase(),
              marks: isDataRecord(priorRosterEntry?.marks) ? priorRosterEntry.marks : {},
            };
            transaction.update(newSectionRef, {
              enrolledStudentUids: [...new Set([...targetUids, uid])],
              students: [...targetRoster.filter((student: DataRecord) => student.id !== uid), studentEntry],
              updatedAt: now,
            });
            transaction.set(userRef, {
              uid,
              role: 'student',
              status: academic.enrollmentStatus,
              name,
              studentId: academic.studentId,
              rollNo: academic.studentId,
              departmentId: academic.departmentId,
              btechYear: academic.btechYear,
              sectionId: academic.sectionId,
              semester: academic.semester,
              updatedAt: now,
            }, { merge: true });
            transaction.set(profileRef, {
              ...profile,
              id: uid,
              authUserId: uid,
              name,
              studentId: academic.studentId,
              rollNo: academic.studentId,
              departmentId: academic.departmentId,
              btechYear: academic.btechYear,
              sectionId: academic.sectionId,
              semester: academic.semester,
              enrollmentStatus: academic.enrollmentStatus,
              enrollmentSectionIds: [academic.sectionId],
              updatedAt: now,
            });
            transaction.set(studentIdRef, { uid, studentId: academic.studentId, updatedAt: now });
            if (oldIndexPosition >= 0 && oldStudentIdSnapshot?.exists && oldStudentIdRef) {
              transaction.delete(oldStudentIdRef);
            }
          });
          firestoreCommitted = true;
          try {
            await auth.updateUser(uid, { displayName: name, disabled: academic.enrollmentStatus !== 'active' });
          } catch (authError) {
            console.error('Student Auth status update failed after Firestore commit:', authError && typeof authError === 'object' && 'code' in authError ? String(authError.code) : 'unknown');
            sendApiError(res, 500, 'STUDENT_AUTH_SYNC_FAILED', 'Academic profile saved, but Firebase Authentication status did not synchronize. Keep this account under administrator review.');
            return;
          }
          res.json({ saved: true, uid, studentId: academic.studentId, enrollmentStatus: academic.enrollmentStatus });
        } catch (error) {
          const code = error instanceof Error ? error.message : error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
          if (authDisabledBeforeTransaction && !firestoreCommitted && !wasDisabled) {
            try {
              await auth.updateUser(uid, { disabled: false });
            } catch (rollbackError) {
              console.error('Student Auth rollback failed:', rollbackError && typeof rollbackError === 'object' && 'code' in rollbackError ? String(rollbackError.code) : 'unknown');
            }
          }
          if (code === 'STUDENT_ID_EXISTS' || code === 'STUDENT_NOT_FOUND' || code === 'CLASS_NOT_FOUND' || code === 'STUDENT_ID_INDEX_CONFLICT') {
            if (code === 'STUDENT_ID_EXISTS') sendApiError(res, 409, 'STUDENT_ID_EXISTS', 'This student ID is already assigned.');
            else if (code === 'STUDENT_ID_INDEX_CONFLICT') sendApiError(res, 409, 'STUDENT_ID_INDEX_CONFLICT', 'The existing student ID index conflicts with this account. No changes were saved.');
            else if (code === 'CLASS_NOT_FOUND') sendApiError(res, 404, 'CLASS_NOT_FOUND', 'The selected class is no longer available.');
            else sendApiError(res, 404, 'STUDENT_NOT_FOUND', 'A linked student profile is required.');
            return;
          }
          console.error('Student academic profile update failed:', { uid, code });
          sendApiError(res, 500, 'STUDENT_UPDATE_FAILED', 'Could not update the student academic profile. Verify the account status before retrying.');
        }
      });

      app.get('/api/course-sections/:sectionId/assessments', verifyFirebaseToken, requireTrustedRole(['student', 'faculty']), async (req, res) => {
        if (!firebaseAdminApp) {
          sendApiError(res, 503, 'ASSESSMENT_SERVICE_UNAVAILABLE', 'Assessment records are unavailable.');
          return;
        }
        const uid = (req as FirebaseRequest).firebaseUser?.uid ?? '';
        const role = (req as FirebaseRequest).trustedRole;
        const sectionId = typeof req.params.sectionId === 'string' ? req.params.sectionId : '';
        if (!isValidDocumentId(sectionId) || !uid || (role !== 'student' && role !== 'faculty')) {
          sendApiError(res, 400, 'INVALID_ASSESSMENT_REQUEST', 'A valid authorized class section is required.');
          return;
        }
        try {
          const firestore = firebaseAdminApp.firestore();
          const section = await firestore.collection('courseSections').doc(sectionId).get();
          if (!section.exists || section.get('status') === 'inactive') {
            sendApiError(res, 404, 'CLASS_NOT_FOUND', 'The class section was not found or is inactive.');
            return;
          }
          if (
            (role === 'faculty' && !isAssignedFaculty(uid, section.data() ?? {}))
            || (role === 'student' && !canReadCourseSection('student', uid, section.data() ?? {}))
          ) {
            sendApiError(res, 403, 'SECTION_ACCESS_DENIED', 'You are not authorized to view assessments for this class.');
            return;
          }
          if (role === 'student') {
            const student = await firestore.collection('students').doc(uid).get();
            if (!student.exists || student.get('authUserId') !== uid || student.get('enrollmentStatus') === 'inactive') {
              sendApiError(res, 403, 'STUDENT_PROFILE_REQUIRED', 'An active linked Student profile is required.');
              return;
            }
          }
          const [assessmentSnapshots, markSnapshots] = await Promise.all([
            firestore.collection('assessments').where('sectionId', '==', sectionId).get(),
            firestore.collection('assessmentMarks').where('sectionId', '==', sectionId).get(),
          ]);
          const assessments: DataRecord[] = assessmentSnapshots.docs.map((document): DataRecord => ({ id: document.id, ...document.data() }));
          const marks: DataRecord[] = markSnapshots.docs
            .filter((document) => role === 'faculty' || document.get('studentUid') === uid)
            .map((document): DataRecord => ({ id: document.id, ...document.data() }));
          const ownedMarkMap = Object.fromEntries(
            marks.filter((mark) => mark.studentUid === uid).map((mark) => [String(mark.assessmentId), Number(mark.obtainedMarks)]),
          );
          const normalizedAssessments: DataRecord[] = assessments.map((assessment): DataRecord => ({
            ...assessment,
            ...(assessment.date instanceof admin.firestore.Timestamp ? { date: assessment.date.toDate().toISOString() } : {}),
          }));
          const grade = role === 'student'
            ? weightedAssessmentPercentage(
              normalizedAssessments.map((assessment) => ({
                id: String(assessment.id),
                name: String(assessment.name),
                type: ASSESSMENT_TYPES.includes(assessment.type as typeof ASSESSMENT_TYPES[number])
                  ? assessment.type as typeof ASSESSMENT_TYPES[number]
                  : 'other',
                maxMarks: Number(assessment.maxMarks),
                date: String(assessment.date ?? ''),
                subjectId: String(assessment.subjectId),
                weightage: Number(assessment.weightage),
                required: assessment.required === true,
              })),
              ownedMarkMap,
            )
            : null;
          res.json({
            assessments: normalizedAssessments,
            marks,
            ...(role === 'student' ? { weightedPercentage: grade } : {}),
          });
        } catch (error) {
          console.error('Assessment lookup failed:', error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown');
          sendApiError(res, 500, 'ASSESSMENT_LOOKUP_FAILED', 'Could not load assessment records.');
        }
      });

      app.post('/api/course-sections/:sectionId/assessments', verifyFirebaseToken, requireTrustedRole(['faculty']), async (req, res) => {
        if (!firebaseAdminApp) {
          sendApiError(res, 503, 'ASSESSMENT_SERVICE_UNAVAILABLE', 'Assessment management is unavailable.');
          return;
        }
        const uid = (req as FirebaseRequest).firebaseUser?.uid ?? '';
        const sectionId = typeof req.params.sectionId === 'string' ? req.params.sectionId : '';
        const assessment = normalizeAssessmentInput(req.body);
        if (!isValidDocumentId(sectionId) || !assessment) {
          sendApiError(res, 400, 'INVALID_ASSESSMENT', 'Provide a valid assessment name, type, maximum marks, date, subject, weightage, and required flag.');
          return;
        }
        const firestore = firebaseAdminApp.firestore();
        const sectionRef = firestore.collection('courseSections').doc(sectionId);
        const userRef = firestore.collection('users').doc(uid);
        try {
          const [section, subjectById, user] = await Promise.all([
            sectionRef.get(),
            firestore.collection('subjects').doc(assessment.subjectId).get(),
            userRef.get(),
          ]);
          if (!section.exists || section.get('status') === 'inactive' || !isAssignedFaculty(uid, section.data() ?? {})) {
            sendApiError(res, 403, 'SECTION_ACCESS_DENIED', 'Only faculty assigned to this active section may manage its assessments.');
            return;
          }
          const subjectQuery = subjectById.exists
            ? null
            : await firestore.collection('subjects')
              .where('sectionIds', 'array-contains', sectionId)
              .get();
          const subjectDocument = subjectById.exists
            ? subjectById
            : subjectQuery?.docs.find((document) => document.get('name') === assessment.subjectId) ?? null;
          const legacySubjects = Array.isArray(section.get('subjects')) ? section.get('subjects') : [];
          const subjectIsLinked = subjectDocument
            ? Array.isArray(subjectDocument.get('sectionIds'))
              && subjectDocument.get('sectionIds').includes(sectionId)
              && subjectDocument.get('facultyUid') === uid
            : legacySubjects.includes(assessment.subjectId) && isAssignedFaculty(uid, section.data() ?? {});
          if (!subjectIsLinked) {
            sendApiError(res, 403, 'SUBJECT_ACCESS_DENIED', 'The assessment subject is not assigned to this faculty member for this section.');
            return;
          }
          const subjectId = subjectDocument?.id ?? assessment.subjectId;
          const subjectName = subjectDocument ? getString(subjectDocument.get('name'), 120) : assessment.subjectId;
          const existingAssessments = await firestore.collection('assessments').where('sectionId', '==', sectionId).get();
          const duplicate = existingAssessments.docs.some((document) =>
            document.get('subjectId') === subjectId
            && document.get('name') === assessment.name
            && document.get('date') === assessment.date);
          if (duplicate) {
            sendApiError(res, 409, 'ASSESSMENT_DUPLICATE', 'An assessment with this name, subject, and date already exists.');
            return;
          }
          const configuredWeight = existingAssessments.docs
            .filter((document) => document.get('subjectId') === subjectId && document.get('required') === true)
            .reduce((sum, document) => sum + Number(document.get('weightage') ?? 0), 0);
          if (assessment.required && configuredWeight + assessment.weightage > 100.001) {
            sendApiError(res, 400, 'WEIGHTAGE_EXCEEDED', 'Required assessment weightages for a subject cannot exceed 100%.');
            return;
          }
          const assessmentId = randomUUID();
          await firestore.collection('assessments').doc(assessmentId).create({
            ...assessment,
            subjectId,
            subjectName,
            id: assessmentId,
            sectionId,
            departmentId: getString(section.get('departmentId'), 128),
            btechYear: section.get('btechYear') ?? null,
            semester: section.get('semester') ?? null,
            facultyUid: uid,
            facultyName: getString(user.get('name'), 120),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          res.status(201).json({ id: assessmentId, ...assessment });
        } catch (error) {
          console.error('Assessment creation failed:', error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown');
          sendApiError(res, 500, 'ASSESSMENT_CREATE_FAILED', 'Could not create the assessment.');
        }
      });

      app.put('/api/course-sections/:sectionId/assessments/:assessmentId/marks/:studentUid', verifyFirebaseToken, requireTrustedRole(['faculty']), async (req, res) => {
        if (!firebaseAdminApp) {
          sendApiError(res, 503, 'ASSESSMENT_SERVICE_UNAVAILABLE', 'Assessment marks are unavailable.');
          return;
        }
        const facultyUid = (req as FirebaseRequest).firebaseUser?.uid ?? '';
        const sectionId = typeof req.params.sectionId === 'string' ? req.params.sectionId : '';
        const assessmentId = typeof req.params.assessmentId === 'string' ? req.params.assessmentId : '';
        const studentUid = typeof req.params.studentUid === 'string' ? req.params.studentUid : '';
        const obtainedMarks = req.body?.obtainedMarks;
        if (!isValidDocumentId(sectionId) || !isValidDocumentId(assessmentId) || !isValidDocumentId(studentUid)) {
          sendApiError(res, 400, 'INVALID_MARK_RECORD', 'A valid section, assessment, and student identity are required.');
          return;
        }
        const firestore = firebaseAdminApp.firestore();
        const sectionRef = firestore.collection('courseSections').doc(sectionId);
        const assessmentRef = firestore.collection('assessments').doc(assessmentId);
        const studentRef = firestore.collection('students').doc(studentUid);
        const markId = `${assessmentId}_${studentUid}`;
        const markRef = firestore.collection('assessmentMarks').doc(markId);
        const auditRef = firestore.collection('assessmentMarkAudit').doc();
        try {
          await firestore.runTransaction(async (transaction) => {
            const [section, assessment, student, mark] = await Promise.all([
              transaction.get(sectionRef),
              transaction.get(assessmentRef),
              transaction.get(studentRef),
              transaction.get(markRef),
            ]);
            if (!section.exists || section.get('status') === 'inactive' || !isAssignedFaculty(facultyUid, section.data() ?? {})) {
              throw new Error('SECTION_ACCESS_DENIED');
            }
            if (!assessment.exists || assessment.get('sectionId') !== sectionId || assessment.get('facultyUid') !== facultyUid) {
              throw new Error('ASSESSMENT_NOT_FOUND');
            }
            if (!student.exists || student.get('authUserId') !== studentUid || student.get('enrollmentStatus') === 'inactive'
              || !canReadCourseSection('student', studentUid, section.data() ?? {})) {
              throw new Error('STUDENT_NOT_ENROLLED');
            }
            const maxMarks = Number(assessment.get('maxMarks'));
            if (!isValidMark(obtainedMarks, maxMarks)) throw new Error('INVALID_MARKS');
            const now = admin.firestore.FieldValue.serverTimestamp();
            const previousMarks = mark.exists ? Number(mark.get('obtainedMarks')) : null;
            if (mark.exists) {
              transaction.create(auditRef, {
                markId,
                sectionId,
                assessmentId,
                studentUid,
                previousMarks,
                obtainedMarks,
                facultyUid,
                changedAt: now,
              });
            }
            transaction.set(markRef, {
              id: markId,
              sectionId,
              assessmentId,
              studentUid,
              departmentId: assessment.get('departmentId') ?? null,
              btechYear: assessment.get('btechYear') ?? null,
              semester: assessment.get('semester') ?? null,
              subjectId: assessment.get('subjectId'),
              obtainedMarks,
              updatedByUid: facultyUid,
              updatedAt: now,
            });
          });
          res.json({ saved: true, markId });
        } catch (error) {
          const code = error instanceof Error ? error.message : '';
          if (code === 'SECTION_ACCESS_DENIED') {
            sendApiError(res, 403, 'SECTION_ACCESS_DENIED', 'Only the assigned faculty may record marks for this section.');
            return;
          }
          if (code === 'ASSESSMENT_NOT_FOUND') {
            sendApiError(res, 404, 'ASSESSMENT_NOT_FOUND', 'Assessment was not found or is not assigned to this faculty member.');
            return;
          }
          if (code === 'STUDENT_NOT_ENROLLED') {
            sendApiError(res, 403, 'STUDENT_NOT_ENROLLED', 'Marks can only be recorded for an active student enrolled in this section.');
            return;
          }
          if (code === 'INVALID_MARKS') {
            sendApiError(res, 400, 'INVALID_MARKS', 'Obtained marks must be a finite number from 0 to the configured maximum.');
            return;
          }
          console.error('Assessment mark save failed:', error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown');
          sendApiError(res, 500, 'ASSESSMENT_MARK_SAVE_FAILED', 'Could not save the assessment mark.');
        }
      });
    });
    res.json({ saved: true, assignedSectionIds: desiredIds });
  } catch (error) {
    const code = error instanceof Error ? error.message : error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
    if (code === 'FACULTY_NOT_FOUND') {
      sendApiError(res, 404, 'FACULTY_NOT_FOUND', 'An active faculty profile is required for course assignment.');
      return;
    }
    if (code === 'SECTION_NOT_FOUND') {
      sendApiError(res, 404, 'COURSE_SECTION_NOT_FOUND', 'One or more selected course sections no longer exist.');
      return;
    }
    console.error('Faculty course assignment failed:', { uid, code });
    sendApiError(res, 500, 'FACULTY_ASSIGNMENT_FAILED', 'Could not update faculty course assignments.');
  }
});

const windows = new Map<string, { count: number; startedAt: number }>();
app.use('/api/groq', (req, res, next) => {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const window = windows.get(key);
  if (!window || now - window.startedAt > 60_000) windows.set(key, { count: 1, startedAt: now });
  else if (window.count >= 12) return res.status(429).json({ error: 'Review limit reached. Please try again in a minute.' });
  else window.count += 1;
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, groqConfigured: Boolean(process.env.GROQ_API_KEY), model });
});

function buildTrustedReviewContext(section: DataRecord, student: DataRecord) {
  const subjects = Array.isArray(section.subjects)
    ? section.subjects.filter((subject): subject is string => typeof subject === 'string').slice(0, 100)
    : [];
  const allStudents = Array.isArray(section.students) ? section.students.filter(isDataRecord) : [];
  const marks = isDataRecord(student.marks) ? student.marks : {};
  const subjectMarks = Object.fromEntries(subjects.flatMap((subject) => {
    const mark = marks[subject];
    return typeof mark === 'number' && Number.isFinite(mark) ? [[subject, mark]] : [];
  }));
  const scoreEntries = Object.entries(subjectMarks) as [string, number][];
  const cohortScores = allStudents.flatMap((record) => {
    const recordMarks = isDataRecord(record.marks) ? record.marks : {};
    const scores = subjects.map((subject) => recordMarks[subject]).filter((mark): mark is number => typeof mark === 'number' && Number.isFinite(mark));
    return scores.length ? [average(scores)] : [];
  });
  const subjectAverages = Object.fromEntries(subjects.flatMap((subject) => {
    const values = allStudents
      .map((record) => isDataRecord(record.marks) ? record.marks[subject] : undefined)
      .filter((mark): mark is number => typeof mark === 'number' && Number.isFinite(mark));
    return values.length ? [[subject, average(values)]] : [];
  }));
  const ranked = [...scoreEntries].sort((left, right) => left[1] - right[1]);
  const materials = Array.isArray(section.materials) ? section.materials.filter(isDataRecord).slice(0, 40) : [];
  const focusSubjects = new Set(ranked.slice(0, 3).map(([subject]) => subject.toLowerCase()));
  const retrievedMaterials = materials.map((material) => {
    const materialSubject = getString(material.subject, 100).toLowerCase();
    const searchable = `${materialSubject} ${Array.isArray(material.tags) ? material.tags.map((tag) => getString(tag, 80)).join(' ') : ''} ${getString(material.name, 240)} ${typeof material.excerpt === 'string' ? material.excerpt.slice(0, 6000) : ''}`.toLowerCase();
    const directlyRelevant = focusSubjects.has(materialSubject) || materialSubject === 'all subjects';
    const topical = [...focusSubjects].some((subject) => searchable.includes(subject));
    const score = (directlyRelevant ? 4 : 0) + (topical ? 2 : 0) + (material.source === 'Faculty upload' ? 1 : 0);
    return { material, score };
  })
    .sort((left, right) => right.score - left.score || getString(left.material.name, 240).localeCompare(getString(right.material.name, 240)))
    .filter(({ score }) => score > 0)
    .slice(0, 4)
    .map(({ material }) => ({
    id: getString(material.id, 160),
    name: getString(material.name, 240) || 'Untitled material',
    type: getString(material.type, 40),
    subject: getString(material.subject, 100),
    tags: Array.isArray(material.tags) ? material.tags.map((tag) => getString(tag, 80)).filter(Boolean).slice(0, 30) : [],
    ...(typeof material.excerpt === 'string' ? { excerpt: material.excerpt.slice(0, 6000) } : {}),
  }));
  return {
    course: {
      title: getString(section.course, 160),
      sectionCode: getString(section.code, 80),
      sectionName: getString(section.name, 120),
      term: getString(section.term, 120),
      facultyName: getString(section.faculty, 120),
      room: getString(section.room, 120),
      schedule: getString(section.schedule, 160),
    },
    cohort: {
      studentCount: allStudents.length,
      overallAverage: average(cohortScores),
      subjectAverages,
    },
    learner: {
      subjectMarks,
      overallAverage: average(scoreEntries.map(([, mark]) => mark)),
      classGap: average(scoreEntries.map(([, mark]) => mark)) - average(cohortScores),
      attendance: typeof student.attendance === 'number' && Number.isFinite(student.attendance) ? student.attendance : undefined,
      strongestSubject: ranked.length ? ranked[ranked.length - 1][0] : 'Not available',
      focusSubjects: ranked.slice(0, 3).map(([subject]) => subject),
    },
    retrievedMaterials,
  };
}

app.post('/api/groq/review', verifyFirebaseToken, requireTrustedRole(['student', 'faculty']), async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Groq is not configured yet. Set GROQ_API_KEY on the server and restart LearnPulse.' });
  if (!firebaseAdminApp) return res.status(503).json({ error: 'Firebase Admin authentication is unavailable. Configure server credentials and restart the API.' });
  const firebaseUser = (req as FirebaseRequest).firebaseUser;
  const uid = firebaseUser?.uid;
  const sectionId = typeof req.body?.sectionId === 'string' ? req.body.sectionId : '';
  const studentId = typeof req.body?.studentId === 'string' ? req.body.studentId : '';
  if (!uid || !sectionId || !studentId) {
    return res.status(400).json({ error: 'A valid section and student are required for a learning review.' });
  }
  let reviewContext: ReturnType<typeof buildTrustedReviewContext>;
  let materialIds: Set<string>;
  try {
    const firestore = firebaseAdminApp.firestore();
    const role = (req as FirebaseRequest).trustedRole;
    const sectionSnapshot = await firestore.collection('courseSections').doc(sectionId).get();
    if (!sectionSnapshot.exists) return res.status(404).json({ error: 'The requested course section was not found.' });
    const section = sectionSnapshot.data() ?? {};
    if (role === 'student') {
      const studentSnapshot = await firestore.collection('students').doc(uid).get();
      if (!studentSnapshot.exists || studentSnapshot.get('authUserId') !== uid) {
        return res.status(403).json({ error: 'A linked student profile is required for a learning review.' });
      }
    }
    if (!canReadCourseSection(role, uid, section)) {
      return res.status(403).json({ error: 'You are not authorized to access this course section.' });
    }
    if (role === 'student' && studentId !== uid) {
      return res.status(403).json({ error: 'Students may request reviews only for their own enrolled record.' });
    }
    const roster = Array.isArray(section.students) ? section.students.filter(isDataRecord) : [];
    const targetStudent = roster.find((student) => student.id === studentId || student.authUserId === studentId);
    if (!targetStudent) {
      return res.status(403).json({ error: 'The requested student is not in this authorized course section.' });
    }
    const storedMarks = isDataRecord(targetStudent.marks) ? targetStudent.marks : {};
    const hasRecordedMarks = Array.isArray(section.subjects) && section.subjects.some((subject) =>
      typeof subject === 'string' && typeof storedMarks[subject] === 'number' && Number.isFinite(storedMarks[subject]));
    if (!hasRecordedMarks) {
      return res.status(409).json({ error: 'A learning review requires recorded marks for this student.' });
    }
    if (role === 'faculty') {
      const [targetUserSnapshot, targetProfileSnapshot] = await Promise.all([
        firestore.collection('users').doc(studentId).get(),
        firestore.collection('students').doc(studentId).get(),
      ]);
      if (targetUserSnapshot.get('role') !== 'student' || !targetProfileSnapshot.exists || targetProfileSnapshot.get('authUserId') !== studentId) {
        return res.status(403).json({ error: 'The selected roster entry is not linked to a trusted Student account.' });
      }
    }
    reviewContext = buildTrustedReviewContext(section, targetStudent);
    materialIds = new Set(reviewContext.retrievedMaterials.map((material) => material.id).filter(Boolean));
  } catch (error) {
    console.error('Groq review authorization failed:', error instanceof Error ? error.message : 'Unknown Firestore error');
    return res.status(500).json({ error: 'Could not verify access to the requested course section.' });
  }
  const reviewSchema = {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      strengths: { type: 'array', items: { type: 'string' } },
      focusAreas: { type: 'array', items: { type: 'object', properties: { subject: { type: 'string' }, evidence: { type: 'string' }, action: { type: 'string' } }, required: ['subject', 'evidence', 'action'], additionalProperties: false } },
      weeklyPlan: { type: 'array', items: { type: 'string' } },
      recommendedMaterials: { type: 'array', items: { type: 'object', properties: { materialId: { type: 'string' }, reason: { type: 'string' } }, required: ['materialId', 'reason'], additionalProperties: false } },
      facultyFollowUp: { type: 'string' },
    },
    required: ['summary', 'strengths', 'focusAreas', 'weeklyPlan', 'recommendedMaterials', 'facultyFollowUp'],
    additionalProperties: false,
  };

  try {
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_completion_tokens: 1100,
        response_format: { type: 'json_schema', json_schema: { name: 'learnpulse_review', strict: true, schema: reviewSchema } },
        messages: [
          {
            role: 'system',
            content: 'You are a careful academic learning coach. Use only the supplied course data, marks, comparisons, and retrieved materials. Do not infer diagnoses, character traits, or causes that are not in evidence. Give kind, specific, age-neutral, actionable study advice. Do not fabricate resources; recommendedMaterials must use only supplied material IDs. Mention numerical evidence accurately. Return a complete review, with 3 to 5 short weekly plan steps and no more than 4 materials. If no resource is relevant, return an empty recommendedMaterials array. Keep the wording human and supportive.',
          },
          { role: 'user', content: JSON.stringify(reviewContext) },
        ],
      }),
    });
    if (!groqResponse.ok) {
      const providerMessage = groqResponse.status === 401 ? 'Groq rejected the server key. Check GROQ_API_KEY.' : groqResponse.status === 429 ? 'Groq rate limit reached. Try again shortly.' : `Groq returned an error (${groqResponse.status}).`;
      return res.status(groqResponse.status === 429 ? 429 : 502).json({ error: providerMessage });
    }
    const body = await groqResponse.json() as { choices?: { message?: { content?: string } }[]; model?: string };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return res.status(502).json({ error: 'Groq returned an empty review. Please try again.' });
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const stringArray = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 7) : [];
    const focusAreas = Array.isArray(parsed.focusAreas) ? parsed.focusAreas.slice(0, 5).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const area = item as Record<string, unknown>;
      return typeof area.subject === 'string' && typeof area.evidence === 'string' && typeof area.action === 'string'
        ? [{ subject: area.subject.slice(0, 100), evidence: area.evidence.slice(0, 500), action: area.action.slice(0, 500) }]
        : [];
    }) : [];
    const recommendedMaterials = Array.isArray(parsed.recommendedMaterials) ? parsed.recommendedMaterials.slice(0, 4).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const suggestion = item as Record<string, unknown>;
      return typeof suggestion.materialId === 'string' && materialIds.has(suggestion.materialId) && typeof suggestion.reason === 'string'
        ? [{ materialId: suggestion.materialId, reason: suggestion.reason.slice(0, 350) }]
        : [];
    }) : [];
    const review = {
      summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 1200) : 'Review the score evidence and focus on the lowest-mark subjects first.',
      strengths: stringArray(parsed.strengths),
      focusAreas,
      weeklyPlan: stringArray(parsed.weeklyPlan).slice(0, 5),
      recommendedMaterials,
      facultyFollowUp: typeof parsed.facultyFollowUp === 'string' ? parsed.facultyFollowUp.slice(0, 600) : 'Discuss the next study step with the learner.',
      model: body.model || model,
    };
    return res.json({ review });
  } catch (error) {
    console.error('Groq review failed:', error instanceof Error ? error.message : 'Unknown error');
    return res.status(502).json({ error: 'Could not complete the Groq review. Check the server connection and try again.' });
  }
});

app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!req.path.startsWith('/api/')) {
    next(error);
    return;
  }
  if (res.headersSent) {
    next(error);
    return;
  }

  const errorType = error && typeof error === 'object' && 'type' in error ? String(error.type) : '';
  const statusValue = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
  const status = errorType === 'entity.parse.failed'
    ? 400
    : errorType === 'entity.too.large'
      ? 413
      : statusValue >= 400 && statusValue < 500
        ? statusValue
        : 500;
  const code = errorType === 'entity.parse.failed'
    ? 'INVALID_JSON_REQUEST'
    : errorType === 'entity.too.large'
      ? 'REQUEST_TOO_LARGE'
      : 'API_REQUEST_FAILED';
  const message = status === 400
    ? 'Request body must contain valid JSON.'
    : status === 413
      ? 'Request body exceeds the allowed size.'
      : 'The API could not complete the request.';
  console.error('LearnPulse API request failed:', req.method, req.path, code);
  sendApiError(res, status, code, message);
});

app.use('/api', (_req, res) => {
  sendApiError(res, 404, 'API_ROUTE_NOT_FOUND', 'The requested API endpoint was not found.');
});

if (isProduction) {
  app.use(express.static(path.join(root, 'dist')));
  app.use((_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
} else {
  const vite = await createViteServer({
    configFile: path.join(root, 'vite.config.ts'),
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => console.log(`LearnPulse listening on http://0.0.0.0:${port}`));
