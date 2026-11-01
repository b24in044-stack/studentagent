import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  Activity, AlertTriangle, ArrowUpRight, BarChart3, Bell, BookOpen, Brain, CalendarDays,
  ClipboardList,
  CheckCircle2, ChevronDown, Download, Eye, EyeOff, FileText, GraduationCap, LayoutDashboard,
  Library, LockKeyhole, LogOut, Mail, Menu, Paperclip, Search, ShieldCheck, Sparkles,
  Settings, Target, UploadCloud, UserRound, Users, X, Zap,
} from 'lucide-react';
import { insightFor, sectionStats, studentAverage, subjectAverage } from './lib/analytics';
import { recommendMaterials } from './lib/rag';
import { requestGroqReview } from './lib/groq';
import { auth, firebaseConfigurationMessage, observeAuthState, registerFirebaseUser, sendPasswordResetEmail, signInWithFirebase, signOutFirebase } from './lib/firebase';
import { getAuthenticatedRedirect, getSignedOutRedirect, getWorkspaceNavigation, normalizeWorkspacePath } from './lib/access';
import { ApiResponseError, isRecoverableStudentProfileError } from './lib/apiResponse';
import { friendlyAuthError, missingRoleMessage, type Role } from './lib/auth';
import { deleteCourseMaterial, downloadCourseMaterial, fetchAuthenticatedProfile, fetchCourseSections, provisionStudentProfile, saveCourseSection, uploadCourseMaterial, type StudentProfile } from './lib/firebaseData';
import FacultyManagement from './components/FacultyManagement';
import CollegeManagement from './components/CollegeManagement';
import AssessmentPanel from './components/AssessmentPanel';
import type { AiReview, CourseMaterial, CourseSection, StudentRecord } from './lib/types';

function cleanText(value: unknown) {
  return String(value ?? '').trim();
}

function getRegistrationError(error: unknown): string {
  const firebaseCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : 'Registration failed. Please try again.';
  return friendlyAuthError(`${firebaseCode} ${message}`);
}

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

function parseRows(rows: Record<string, unknown>[], _sectionId: string): { students: StudentRecord[]; subjects: string[] } | null {
  if (!rows.length) return null;
  const headers = Object.keys(rows[0]);
  const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const find = (terms: string[]) => headers.find((header) => terms.some((term) => clean(header).includes(term)));
  const nameKey = find(['studentname', 'student', 'learner', 'pupil', 'name']);
  const rollKey = find(['rollno', 'rollnumber', 'studentid', 'registration', 'admission', 'roll']);
  const attendanceKey = find(['attendance', 'attend', 'present']);
  const emailKey = find(['email', 'mail']);
  const excluded = new Set([nameKey, rollKey, attendanceKey, emailKey].filter(Boolean));
  const subjects = headers.filter((header) => !excluded.has(header) && rows.some((row) => cleanText(row[header]) !== '' && Number.isFinite(Number(row[header]))));
  if (!subjects.length) return null;
  const students = rows.filter((row) => Object.values(row).some((value) => cleanText(value))).map((row, index) => ({
    id: crypto.randomUUID(),
    name: String((nameKey && row[nameKey]) || `Student ${index + 1}`),
    rollNo: String((rollKey && row[rollKey]) || `uploaded-${String(index + 1).padStart(3, '0')}`),
    email: emailKey ? String(row[emailKey] ?? '').trim().toLowerCase() || undefined : undefined,
    attendance: attendanceKey && row[attendanceKey] !== '' && row[attendanceKey] !== undefined ? Number(row[attendanceKey]) : undefined,
    marks: Object.fromEntries(subjects.map((subject) => [subject, Number(row[subject]) || 0])),
  }));
  return { students, subjects };
}

async function extractTextExcerpt(file: File): Promise<string | undefined> {
  if (file.size > 20 * 1024 * 1024) throw new Error('Course material files must be 20 MB or smaller.');
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (['txt', 'md', 'csv', 'log'].includes(extension ?? '')) return (await file.text()).slice(0, 6000);
  if (extension === 'docx') {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value.slice(0, 6000) || undefined;
  }
  if (extension === 'pdf') {
    const [pdfjsLib, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
    pdfjsLib.GlobalWorkerOptions.workerSrc = worker.default;
    const loadingTask = pdfjsLib.getDocument({ data: await file.arrayBuffer() });
    const document = await loadingTask.promise;
    const pages = Math.min(document.numPages, 12);
    const pageTexts: string[] = [];
    for (let number = 1; number <= pages; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      pageTexts.push(content.items.map((item) => 'str' in item ? item.str : '').filter(Boolean).join(' '));
      if (pageTexts.join(' ').length >= 6000) break;
    }
    const excerpt = pageTexts.join(' ').slice(0, 6000).trim();
    await loadingTask.destroy();
    return excerpt || undefined;
  }
  return undefined;
}

function csvCell(value: unknown) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadBlob(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadCsv(section: CourseSection) {
  const header = ['Student Name', 'Roll No', ...section.subjects, 'Average', 'Attendance'];
  const lines = section.students.map((student) => [student.name, student.rollNo, ...section.subjects.map((subject) => student.marks[subject]), studentAverage(student, section.subjects).toFixed(2), student.attendance ?? '']);
  downloadBlob([header, ...lines].map((row) => row.map(csvCell).join(',')).join('\n'), `${section.code.toLowerCase()}-marks.csv`, 'text/csv;charset=utf-8');
}

async function downloadXlsx(section: CourseSection) {
  const XLSX = await import('xlsx');
  const rows = section.students.map((student) => ({ 'Student Name': student.name, 'Roll No': student.rollNo, ...student.marks, Average: Number(studentAverage(student, section.subjects).toFixed(2)), Attendance: student.attendance ?? '' }));
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Marks');
  XLSX.writeFile(workbook, `${section.code.toLowerCase()}-marks.xlsx`);
}

function downloadIndividualMarks(section: CourseSection, student: StudentRecord) {
  const rows = [
    ['Student Name', student.name], ['Roll No', student.rollNo], ['Course', section.course], ['Section', `${section.code} · ${section.name}`], ['Faculty', section.faculty], ['Term', section.term], ['Attendance', student.attendance ?? 'Not provided'], ['Overall average', `${studentAverage(student, section.subjects).toFixed(2)}%`], [],
    ['Subject', 'Student mark', 'Section subject average', 'Difference'],
    ...section.subjects.map((subject) => [subject, student.marks[subject] ?? '', subjectAverage(section, subject).toFixed(2), ((student.marks[subject] ?? 0) - subjectAverage(section, subject)).toFixed(2)]),
  ];
  downloadBlob(rows.map((row) => row.map(csvCell).join(',')).join('\n'), `${student.rollNo}-marks.csv`, 'text/csv;charset=utf-8');
}

function downloadReport(section: CourseSection, student: StudentRecord, review?: AiReview) {
  const insight = insightFor(section, student);
  const subjectRows = section.subjects.map((subject) => `<tr><td>${escapeHtml(subject)}</td><td>${student.marks[subject] ?? '—'}%</td><td>${subjectAverage(section, subject).toFixed(1)}%</td><td>${((student.marks[subject] ?? 0) - subjectAverage(section, subject)).toFixed(1)} points</td></tr>`).join('');
  const aiSection = review ? `<h2>Groq learning review</h2><p>${escapeHtml(review.summary)}</p><h3>Suggested weekly plan</h3><ul>${review.weeklyPlan.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul><h3>Faculty follow-up</h3><p>${escapeHtml(review.facultyFollowUp)}</p>` : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(student.name)} · LearnPulse report</title><style>body{font-family:Arial;color:#20242a;max-width:760px;margin:40px auto;padding:0 20px}h1{color:#d96925}h2{border-bottom:2px solid #f3d5bd;padding-bottom:8px;color:#9c4e1e}table{border-collapse:collapse;width:100%;margin:14px 0}td,th{border:1px solid #ddd;padding:9px;text-align:left}th{background:#f8eee7}.pill{display:inline-block;background:#fff0e5;padding:8px 12px;border-radius:18px;margin:4px 4px 4px 0}.muted{color:#65707a}</style></head><body><p class="muted">LEARNPULSE · INDIVIDUAL PERFORMANCE REVIEW</p><h1>${escapeHtml(student.name)}</h1><p>Roll no. <b>${escapeHtml(student.rollNo)}</b> · ${escapeHtml(section.course)} · ${escapeHtml(section.code)} · Faculty: ${escapeHtml(section.faculty)}</p><div class="pill">Average ${insight.overall.toFixed(2)}%</div><div class="pill">Class average ${insight.classAverage.toFixed(2)}%</div><div class="pill">Gap ${insight.gap >= 0 ? '+' : ''}${insight.gap.toFixed(2)}</div><div class="pill">Attendance ${student.attendance === undefined ? 'Not provided' : `${student.attendance}%`}</div><h2>Strengths</h2><p>${insight.strengths.map(escapeHtml).join(' ')}</p><h2>Improvement focus</h2><p>${insight.weaknesses.map(escapeHtml).join(' ')}</p><p><b>Next action:</b> ${escapeHtml(insight.recommendation)}</p><h2>Subject review</h2><table><tr><th>Subject</th><th>Student</th><th>Section average</th><th>Difference</th></tr>${subjectRows}</table>${aiSection}<p class="muted">Generated by LearnPulse. Review with the course faculty.</p></body></html>`;
  downloadBlob(html, `${student.rollNo}-performance-report.html`, 'text/html;charset=utf-8');
}

function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const workspacePath = normalizeWorkspacePath(location.pathname);
  const [role, setRole] = useState<Role>('student');
  const [authenticatedRole, setAuthenticatedRole] = useState<Role | null>(null);
  const [studentProfile, setStudentProfile] = useState<StudentProfile | null>(null);
  const [authReady, setAuthReady] = useState(!auth);
  const [profileSetupPending, setProfileSetupPending] = useState(false);
  const registrationInProgress = useRef(false);
  const [authNotice, setAuthNotice] = useState('');
  const [workspaceReady, setWorkspaceReady] = useState(Boolean(auth));
  const [backendNotice, setBackendNotice] = useState('');
  const [courseLoadError, setCourseLoadError] = useState<Error | null>(null);
  const [sections, setSections] = useState<CourseSection[]>([]);
  const [sectionId, setSectionId] = useState('');
  const [mobileNav, setMobileNav] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const accessibleSections = sections;
  const section = accessibleSections.find((item) => item.id === sectionId) ?? accessibleSections[0];
  useEffect(() => {
    if (!auth) {
      setAuthReady(true);
      return;
    }
    let active = true;
    const unsubscribe = observeAuthState(async (user) => {
      if (!active) return;
      if (registrationInProgress.current) return;
      if (!user) {
        setAuthenticatedRole(null);
        setStudentProfile(null);
        setSections([]);
        setSectionId('');
        setAuthReady(true);
        const redirect = getSignedOutRedirect(location.pathname);
        if (redirect) navigate(redirect, { replace: true });
        return;
      }
      try {
        const account = await fetchAuthenticatedProfile();
        setRole(account.role);
        setAuthenticatedRole(account.role);
        setStudentProfile(account.studentProfile);
        setAuthNotice('');
      } catch (error) {
        if (isRecoverableStudentProfileError(error) && auth?.currentUser) {
          setProfileSetupPending(true);
          setAuthenticatedRole(null);
          setStudentProfile(null);
          setAuthNotice('This Firebase account is signed in, but its Student profile is incomplete. Retry setup to provision the missing profile without creating another account.');
          if (workspacePath !== '/register') navigate('/register', { replace: true });
          return;
        }
        setAuthNotice(error instanceof Error ? error.message : missingRoleMessage());
        setAuthenticatedRole(null);
        setStudentProfile(null);
        try { await signOutFirebase(); } catch { /* ignore */ }
      } finally {
        if (active) setAuthReady(true);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [location.pathname, navigate]);

  useEffect(() => {
    if (!authenticatedRole || !auth) return;
    if (authenticatedRole === 'admin') {
      setSections([]);
      setSectionId('');
      setBackendNotice('');
      setCourseLoadError(null);
      setWorkspaceReady(true);
      return;
    }
    let active = true;
    setWorkspaceReady(false);
    setBackendNotice('');
    setCourseLoadError(null);
    setSections([]);
    void fetchCourseSections().then((remoteSections) => {
      if (!active) return;
      setSections(remoteSections);
      setSectionId(remoteSections[0]?.id ?? '');
    }).catch((error: unknown) => {
      if (!active) return;
      const message = error instanceof Error ? error.message : 'Could not load course data from Firestore.';
      setCourseLoadError(error instanceof Error ? error : new Error(message));
      setBackendNotice(message);
    }).finally(() => {
      if (active) setWorkspaceReady(true);
    });
    return () => { active = false; };
  }, [authenticatedRole]);

  const signIn = async (email: string, password: string): Promise<string | null> => {
    if (!auth) return firebaseConfigurationMessage;
    registrationInProgress.current = true;
    let signedInUid: string | null = null;
    let profileRecoveryAttempted = false;
    try {
      const { user } = await signInWithFirebase(email, password);
      signedInUid = user.uid;
      let account: Awaited<ReturnType<typeof fetchAuthenticatedProfile>>;
      try {
        account = await fetchAuthenticatedProfile();
      } catch (error) {
        if (!isRecoverableStudentProfileError(error)) throw error;
        profileRecoveryAttempted = true;
        await provisionStudentProfile(user.displayName || user.email?.split('@')[0] || 'Student');
        account = await fetchAuthenticatedProfile();
      }
      setRole(account.role);
      setStudentProfile(account.studentProfile);
      setAuthenticatedRole(account.role);
      setAuthNotice('');
      setProfileSetupPending(false);
      registrationInProgress.current = false;
      navigate('/', { replace: true });
      return null;
    } catch (error) {
      if (profileRecoveryAttempted && signedInUid && auth.currentUser?.uid === signedInUid) {
        setProfileSetupPending(true);
        setAuthNotice(`Signed in, but profile verification or setup could not finish. ${getRegistrationError(error)} Retry setup without creating another Firebase account.`);
        registrationInProgress.current = false;
        navigate('/register', { replace: true });
        return null;
      }
      registrationInProgress.current = false;
      try { await signOutFirebase(); } catch { /* ignore */ }
      return getRegistrationError(error);
    }
  };

  const registerStudent = async (name: string, email: string, password: string): Promise<{ error?: string; message?: string; signedIn?: boolean }> => {
    if (!auth) return { error: firebaseConfigurationMessage };
    registrationInProgress.current = true;
    let accountCreated = false;
    try {
      await registerFirebaseUser(email.trim().toLowerCase(), password);
      accountCreated = true;
      await provisionStudentProfile(name);
      const account = await fetchAuthenticatedProfile();
      if (account.role !== 'student' || !account.studentProfile) {
        throw new Error('Student profile provisioning completed, but the backend did not confirm a linked Student profile.');
      }
      setRole(account.role);
      setStudentProfile(account.studentProfile);
      setAuthenticatedRole(account.role);
      setProfileSetupPending(false);
      setAuthNotice('');
      registrationInProgress.current = false;
      navigate('/', { replace: true });
      return { signedIn: true };
    } catch (error) {
      if (accountCreated) {
        setProfileSetupPending(true);
        registrationInProgress.current = false;
        return {
          error: `Your Firebase account was created, but student profile setup did not finish. ${getRegistrationError(error)} Your account is safe. Retry profile setup here, or sign in with this account later to continue recovery.`,
          message: 'retry-profile-setup',
        };
      }
      registrationInProgress.current = false;
      return { error: getRegistrationError(error) };
    }
  };

  const retryProfileSetup = async (): Promise<string | null> => {
    const user = auth?.currentUser;
    if (!user) {
      registrationInProgress.current = false;
      setProfileSetupPending(false);
      return 'Your Firebase session has expired. Sign in and contact an administrator if profile setup still fails.';
    }
    registrationInProgress.current = true;
    try {
      await provisionStudentProfile(user.displayName || user.email?.split('@')[0] || 'Student');
      const account = await fetchAuthenticatedProfile();
      if (account.role !== 'student' || !account.studentProfile) {
        throw new Error('Student profile provisioning completed, but the backend did not confirm a linked Student profile.');
      }
      setRole(account.role);
      setStudentProfile(account.studentProfile);
      setAuthenticatedRole(account.role);
      setProfileSetupPending(false);
      setAuthNotice('');
      registrationInProgress.current = false;
      navigate('/', { replace: true });
      return null;
    } catch (error) {
      registrationInProgress.current = false;
      return getRegistrationError(error);
    }
  };

  const [signingOut, setSigningOut] = useState(false);
  const signOut = async () => {
    if (!auth) return;
    setSigningOut(true);
    try {
      await signOutFirebase();
    } catch (error) {
      setAuthNotice(`Could not sign out: ${error instanceof Error ? error.message : 'Firebase sign-out failed.'}`);
      setSigningOut(false);
      return;
    }
    setAuthenticatedRole(null);
    setStudentProfile(null);
    setSections([]);
    navigate('/login', { replace: true });
  };

  if (!authReady) {
    return <main className="login-page"><div className="login-card"><p className="login-intro">Checking your Firebase session…</p></div></main>;
  }

  if (!authenticatedRole) {
    if (workspacePath === '/register') {
      return <RegisterPage onRegister={registerStudent} onRetryProfileSetup={retryProfileSetup} profileSetupPending={profileSetupPending} authConfigured={Boolean(auth)} recoveryNotice={authNotice} />;
    }
    if (workspacePath !== '/login') return <Navigate to="/login" replace />;
    return <LoginPage role={role} onRoleChange={setRole} onSignIn={signIn} authConfigured={Boolean(auth)} authNotice={authNotice} />;
  }
  const authenticatedRedirect = getAuthenticatedRedirect(location.pathname, authenticatedRole);
  if (authenticatedRedirect) return <Navigate to={authenticatedRedirect} replace />;

  if (authenticatedRole && !workspaceReady) {
    return <WorkspaceLoading />;
  }

  const navigation = getWorkspaceNavigation(authenticatedRole);
  const pageTitle = navigation.find((item) => item.path === workspacePath)?.label ?? 'Overview';
  const setSection = (id: string) => {
    const next = accessibleSections.find((item) => item.id === id);
    if (!next) return;
    setSectionId(id);
  };
  const updateSection = async (next: CourseSection): Promise<boolean> => {
    try {
      await saveCourseSection(next);
      const refreshedSections = await fetchCourseSections();
      setSections(refreshedSections);
      setBackendNotice('');
      return true;
    } catch (error) {
      setBackendNotice(error instanceof Error ? error.message : 'Could not save course data to Firestore.');
      return false;
    }
  };
  const retryCourseLoad = async () => {
    setWorkspaceReady(false);
    setBackendNotice('');
    setCourseLoadError(null);
    try {
      const remoteSections = await fetchCourseSections();
      setSections(remoteSections);
      setSectionId(remoteSections[0]?.id ?? '');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not load course data from Firestore.';
      setCourseLoadError(error instanceof Error ? error : new Error(message));
      setBackendNotice(message);
    } finally {
      setWorkspaceReady(true);
    }
  };
  const renderModule = () => {
    if (authenticatedRole === 'admin') {
      return workspacePath === '/admin/college' ? <CollegeManagement /> : <FacultyManagement />;
    }
    if (authenticatedRole === 'student') {
      if (workspacePath === '/profile') return <ProfilePage />;
      if (workspacePath === '/timetable') return <ModuleUnavailable title="Timetable" reason="A timetable or class-schedule endpoint and data schema are not present in the current backend." />;
      if (workspacePath === '/assignments') return <ModuleUnavailable title="Assignments" reason="Assignment deadlines, submissions, and feedback are not currently stored or served by an application API." />;
      if (workspacePath === '/examinations') return <ModuleUnavailable title="Examinations" reason="The current Firestore/API model does not provide examination schedules or examination-room records." />;
      if (workspacePath === '/notifications') return <ModuleUnavailable title="Notifications" reason="There is no notification feed or delivery endpoint available in the current application." />;
      if (workspacePath === '/settings') return <ModuleUnavailable title="Settings" reason="Account settings are managed through Firebase Authentication; editable portal preferences are not currently persisted." />;
      if (courseLoadError && !['/profile', '/timetable', '/assignments', '/examinations', '/notifications', '/settings'].includes(workspacePath)) {
        return <ModuleRequestError error={courseLoadError} onRetry={() => { void retryCourseLoad(); }} />;
      }
      if (workspacePath === '/attendance') return <StudentAttendance sections={sections} profile={studentProfile} />;
      if (workspacePath === '/results') return <StudentResults sections={sections} profile={studentProfile} />;
      if (workspacePath === '/ai-assistant') return <StudentLearningSignals sections={sections} profile={studentProfile} assistantMode />;
      if (workspacePath === '/performance') return <StudentPerformance sections={sections} profile={studentProfile} />;
      if (workspacePath === '/courses') return <StudentCourses sections={sections} profile={studentProfile} />;
      if (workspacePath === '/materials') return <StudentCourseLibrary sections={sections} />;
      if (workspacePath === '/learning-signals') return <StudentLearningSignals sections={sections} profile={studentProfile} />;
      return <StudentOverview sections={sections} profile={studentProfile} />;
    }
    if (workspacePath === '/profile') return <ProfilePage />;
    if (workspacePath === '/subjects') return <FacultySubjects sections={sections} />;
    if (workspacePath === '/attendance') return <FacultyAttendance sections={sections} onUpdate={updateSection} />;
    if (workspacePath === '/assignments') return <ModuleUnavailable title="Assignments" reason="Assignment creation, submission review, and grading have no backend data model or API in this project." />;
    if (workspacePath === '/notifications') return <ModuleUnavailable title="Notifications" reason="There is no notification feed or delivery endpoint available in the current application." />;
    if (workspacePath === '/settings') return <ModuleUnavailable title="Settings" reason="Faculty account changes require administrator provisioning; no faculty profile-edit endpoint is currently available." />;
    if (courseLoadError && !['/profile', '/assignments', '/notifications', '/settings'].includes(workspacePath)) {
      return <ModuleRequestError error={courseLoadError} onRetry={() => { void retryCourseLoad(); }} />;
    }
    if (workspacePath === '/materials' || workspacePath === '/marks') {
      return section
        ? <FacultyView section={section} sections={sections} onSection={setSection} onUpdate={updateSection} mode={workspacePath === '/marks' ? 'marks' : 'materials'} />
        : <FacultyEmptyModule title={workspacePath === '/marks' ? 'Marks & Grades' : 'Study Materials'} message="No class is assigned yet. Ask an administrator to create a class and assign it to your faculty account." />;
    }
    if (workspacePath === '/monitoring') {
      return section
        ? <FacultyView section={section} sections={sections} onSection={setSection} onUpdate={updateSection} mode="monitoring" />
        : <FacultyEmptyModule title="Student Monitoring" message="No course sections are assigned to this faculty account yet." />;
    }
    if (workspacePath === '/performance') {
      return section
        ? <FacultyView section={section} sections={sections} onSection={setSection} onUpdate={updateSection} mode="performance" />
        : <FacultyEmptyModule title="Student Performance" message="Performance summaries require an assigned section with student records." />;
    }
    if (workspacePath === '/courses') {
      return section
        ? <FacultyView section={section} sections={sections} onSection={setSection} onUpdate={updateSection} mode="courses" />
        : <FacultyEmptyModule title="Course Management" message="Ask an administrator to create a class and assign it to your faculty account." />;
    }
    if (workspacePath === '/learning-signals') return <FacultyLearningSignals sections={sections} />;
    return <FacultyOverview sections={sections} onOpenSection={(id) => { setSection(id); navigate('/monitoring'); }} />;
  };
  const groupedNavigation = navigation.reduce<Array<{ group: string; items: typeof navigation }>>((groups, item) => {
    const group = groups.find((candidate) => candidate.group === item.group);
    if (group) group.items.push(item);
    else groups.push({ group: item.group, items: [item] });
    return groups;
  }, []);
  return <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''} ${sidebarCollapsed ? 'sidebar-is-collapsed' : ''}`}>
      <div className="brand"><div className="brand-mark"><Activity size={18} /></div><div><strong>LearnPulse</strong><span>Education intelligence</span></div><button className="icon-button mobile-close" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={18} /></button></div>
      <nav aria-label="Workspace navigation">
        {groupedNavigation.map((group) => <div className="nav-group" key={group.group}>
          <div className="side-label">{group.group}</div>
          {group.items.map((item) => <Link
          key={item.path}
          to={item.path}
          className={`nav-item ${workspacePath === item.path ? 'active' : ''}`}
          title={sidebarCollapsed ? item.label : undefined}
          aria-label={item.label}
          aria-current={workspacePath === item.path ? 'page' : undefined}
          onClick={() => setMobileNav(false)}
        >
          {workspaceIcon(item.path)}
          <span>{item.label}</span>
          {workspacePath === item.path && <ArrowUpRight size={14} />}
          </Link>)}
        </div>)}
      </nav>
      <div className="sidebar-spacer" />
      <div className="privacy-note"><ShieldCheck size={16} /><div><b>Explainable by design</b><span>Marks and comparisons stay visible with every recommendation.</span></div></div>
      <div className="profile-chip"><div className="avatar">{initials(studentProfile?.name || section?.faculty || 'LearnPulse')}</div><div><b>{studentProfile?.name || section?.faculty || (role === 'faculty' ? 'Faculty account' : role === 'admin' ? 'Administrator' : 'Student account')}</b><span>{role === 'faculty' ? 'Faculty workspace' : role === 'admin' ? 'Administration' : studentProfile?.rollNo || 'Student workspace'}</span></div><button className="sign-out-button sidebar-signout" onClick={() => { void signOut(); }} aria-label="Sign out"><LogOut size={15} /></button></div>
    </aside>
    {mobileNav && <button className="mobile-scrim" onClick={() => setMobileNav(false)} aria-label="Close navigation" />}
    <main className="main-content">
      <header className="topbar"><button className="icon-button desktop-collapse" onClick={() => setSidebarCollapsed((current) => !current)} aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!sidebarCollapsed} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}><Menu size={18} /></button><button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation" aria-expanded={mobileNav}><Menu size={20} /></button><div className="header-title"><div className="breadcrumb"><span>LearnPulse</span><b>/</b><strong>{pageTitle}</strong></div><h1>{pageTitle}</h1></div><div className="top-actions"><span className="authenticated-role">{role === 'faculty' ? <UserRound size={14} /> : role === 'admin' ? <ShieldCheck size={14} /> : <GraduationCap size={14} />}{role === 'faculty' ? 'Faculty account' : role === 'admin' ? 'Administrator' : 'Student account'}</span>{role !== 'admin' && <Link className="header-notifications" to="/notifications" aria-label="Notifications"><Bell size={17} /></Link>}<button className="header-signout" type="button" onClick={() => { void signOut(); }} disabled={signingOut} aria-label="Sign out"><LogOut size={15} /><span>{signingOut ? 'Signing out…' : 'Sign out'}</span></button></div></header>
      {authNotice && <div className="auth-banner auth-error" role="status">{authNotice}</div>}
      {backendNotice && <div className="auth-banner auth-error" role="alert">{backendNotice}<button className="text-button" onClick={() => { void retryCourseLoad(); }}>Retry</button></div>}
      {renderModule()}
    </main>
  </div>;
}

function WorkspaceLoading() {
  return <main className="workspace-loading" aria-label="Loading workspace">
    <div className="loading-brand">LearnPulse</div>
    <div className="loading-skeleton loading-title" />
    <div className="loading-skeleton loading-copy" />
    <div className="loading-skeleton-grid">{[1, 2, 3].map((item) => <div className="loading-skeleton loading-card" key={item} />)}</div>
    <p>Loading your account and authorized course data…</p>
  </main>;
}

function ModuleHeading({ eyebrow, title, copy, action }: { eyebrow: string; title: string; copy: string; action?: ReactNode }) {
  return <section className="module-heading">
    <div><div className="eyebrow"><span className="live-dot" /> {eyebrow}</div><h1>{title}</h1><p className="hero-copy">{copy}</p></div>
    {action && <div className="module-heading-action">{action}</div>}
  </section>;
}

function ModuleEmpty({ title, message, action }: { title: string; message: string; action?: ReactNode }) {
  return <section className="panel module-empty" aria-live="polite">
    <div className="panel-kicker"><BookOpen size={16} /> LearnPulse workspace</div>
    <h2>{title}</h2><p>{message}</p>{action && <div className="no-section-actions">{action}</div>}
  </section>;
}

function ModuleUnavailable({ title, reason }: { title: string; reason: string }) {
  return <div className="page-wrap module-page">
    <ModuleHeading eyebrow="Academic services" title={title} copy="This module is protected by your account role. It only displays information supported by current application data." />
    <ModuleEmpty title={`${title} data is not available`} message={`${reason} No academic information has been generated or fabricated.`} />
  </div>;
}

function workspaceIcon(path: string) {
  if (path === '/admin/college') return <ShieldCheck size={17} />;
  if (path === '/admin/faculty') return <Users size={17} />;
  if (path === '/') return <LayoutDashboard size={17} />;
  if (path === '/profile') return <UserRound size={17} />;
  if (path.includes('attendance') || path.includes('timetable') || path.includes('examinations')) return <CalendarDays size={17} />;
  if (path.includes('assignments') || path === '/marks' || path === '/results') return <ClipboardList size={17} />;
  if (path.includes('material') || path === '/courses' || path === '/subjects') return <BookOpen size={17} />;
  if (path.includes('notification')) return <Bell size={17} />;
  if (path.includes('settings')) return <Settings size={17} />;
  if (path.includes('monitoring')) return <Users size={17} />;
  if (path.includes('ai-assistant')) return <Sparkles size={17} />;
  return <BarChart3 size={17} />;
}

function ProfilePage() {
  return <div className="page-wrap module-page">
    <ModuleHeading eyebrow="Account" title="My Profile" copy="Your profile details are not displayed on this page." />
    <section className="panel module-empty profile-private-state" aria-label="Profile information hidden">
      <div className="panel-kicker"><ShieldCheck size={16} /> Private account area</div>
      <h2>Profile information hidden</h2>
      <p>Personal and account details are not shown here.</p>
    </section>
  </div>;
}

function FacultySubjects({ sections }: { sections: CourseSection[] }) {
  const subjects = sections.flatMap((section) => section.subjects.map((subject) => ({ section, subject })));
  return <div className="page-wrap module-page">
    <ModuleHeading eyebrow="Authorized teaching allocation" title="My Subjects" copy="Subjects are listed only from course sections assigned to your authenticated faculty UID." />
    {subjects.length ? <div className="module-card-grid">{subjects.map(({ section, subject }) => <article className="panel module-course-card" key={`${section.id}-${subject}`}><div className="panel-kicker"><BookOpen size={15} /> {section.code}</div><h3>{subject}</h3><p>{section.course} · {section.term}</p><div className="detail-list"><div><span>Section</span><b>{section.name}</b></div><div><span>Enrolled students</span><b>{section.students.length}</b></div></div></article>)}</div>
      : <ModuleEmpty title="No subject data available" message={sections.length ? 'No subjects have been recorded for your assigned sections.' : 'No sections are assigned to your account.'} />}
  </div>;
}

function FacultyAttendance({ sections, onUpdate }: { sections: CourseSection[]; onUpdate: (section: CourseSection) => Promise<boolean> }) {
  const [sectionId, setSectionId] = useState(sections[0]?.id ?? '');
  const [attendance, setAttendance] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const section = sections.find((item) => item.id === sectionId);
  useEffect(() => {
    if (!sections.some((item) => item.id === sectionId)) setSectionId(sections[0]?.id ?? '');
    const active = sections.find((item) => item.id === sectionId);
    setAttendance(Object.fromEntries((active?.students ?? []).map((student) => [student.id, student.attendance === undefined ? '' : String(student.attendance)])));
  }, [sections, sectionId]);
  const saveAttendance = async (event: FormEvent) => {
    event.preventDefault();
    if (!section) return;
    if (Object.values(attendance).some((value) => value.trim() !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100))) {
      setNotice('Attendance must be a percentage from 0 to 100. Leave a field blank when data is unavailable.');
      return;
    }
    setSaving(true);
    setNotice('');
    try {
      const students = section.students.map((student) => {
        const value = attendance[student.id]?.trim() ?? '';
        return { ...student, attendance: value === '' ? undefined : Number(value) };
      });
      if (await onUpdate({ ...section, students })) setNotice('Attendance saved for this assigned section.');
      else setNotice('Attendance could not be saved. Check the API error above and retry.');
    } finally { setSaving(false); }
  };
  const recorded = section?.students.filter((student) => typeof student.attendance === 'number') ?? [];
  return <div className="page-wrap module-page">
    <ModuleHeading eyebrow="Faculty attendance" title="Attendance Management" copy="Record attendance percentages for students in sections assigned to your faculty account." />
    {!section ? <ModuleEmpty title="No assigned sections" message="Attendance management is limited to your assigned sections." /> : <>
      {sections.length > 1 && <label className="select-wrap module-section-select"><span>Assigned section</span><select value={section.id} onChange={(event) => { setNotice(''); setSectionId(event.target.value); }}>{sections.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select><ChevronDown size={15} /></label>}
      <section className="metrics-grid"><Metric label="Students" value={String(section.students.length)} detail={section.code} icon={<Users size={16} />} /><Metric label="Attendance records" value={String(recorded.length)} detail="Recorded values only" icon={<CalendarDays size={16} />} /><Metric label="Average attendance" value={recorded.length ? `${(recorded.reduce((sum, student) => sum + (student.attendance ?? 0), 0) / recorded.length).toFixed(1)}%` : '—'} detail={recorded.length ? 'This assigned section' : 'No attendance recorded'} icon={<Activity size={16} />} /></section>
      {section.students.length ? <form className="panel attendance-editor" onSubmit={(event) => { void saveAttendance(event); }}><div className="section-heading-row"><div><div className="panel-kicker"><CalendarDays size={15} /> {section.code} attendance</div><h2>Student records</h2></div><button className="primary-button" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save attendance'}</button></div><div className="table-shell"><table className="student-table"><thead><tr><th>Student</th><th>Roll number</th><th>Attendance %</th></tr></thead><tbody>{section.students.map((student) => <tr key={student.id}><td>{student.name}</td><td>{student.rollNo || '—'}</td><td><input aria-label={`Attendance percentage for ${student.name}`} className="attendance-input" type="number" min="0" max="100" step="0.1" value={attendance[student.id] ?? ''} onChange={(event) => setAttendance((current) => ({ ...current, [student.id]: event.target.value }))} placeholder="Not recorded" /></td></tr>)}</tbody></table></div>{notice && <p className="attendance-notice" role="status">{notice}</p>}</form>
        : <ModuleEmpty title="No student records in this section" message="Add an eligible student through the existing course roster workflow before recording attendance." />}
    </>}
  </div>;
}

function StudentAttendance({ sections, profile }: { sections: CourseSection[]; profile: StudentProfile | null }) {
  const rows = sections.flatMap((section) => {
    const student = ownStudent(section, profile);
    return student && typeof student.attendance === 'number' && Number.isFinite(student.attendance)
      ? [{ section: section.code, course: section.course, attendance: student.attendance }]
      : [];
  });
  const averageAttendance = rows.length ? rows.reduce((sum, item) => sum + item.attendance, 0) / rows.length : null;
  return <div className="page-wrap module-page">
    <ModuleHeading eyebrow="Student attendance" title="Attendance" copy="Attendance data is shown only when recorded for your authenticated student profile." />
    {!rows.length ? <ModuleEmpty title="No attendance records available" message={sections.length ? 'Your enrolled sections do not currently have attendance percentages recorded.' : 'Attendance will appear after faculty enrolls you and records attendance.'} /> : <>
      <section className="metrics-grid"><Metric label="Sections with attendance" value={String(rows.length)} detail="Recorded values" icon={<CalendarDays size={16} />} /><Metric label="Average attendance" value={`${averageAttendance!.toFixed(1)}%`} detail="Across sections with records" icon={<Activity size={16} />} tone={averageAttendance! < 75 ? 'alert' : 'good'} /></section>
      <section className="panel chart-panel"><div className="panel-kicker"><BarChart3 size={16} /> Attendance by course</div><div className="performance-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={rows} margin={{ top: 12, right: 12, left: -12, bottom: 28 }}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="section" /><YAxis domain={[0, 100]} /><Tooltip formatter={(value) => [`${value}%`, 'Attendance']} /><Bar dataKey="attendance" fill="#2563eb" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div></section>
      <div className="table-shell"><table className="student-table"><thead><tr><th>Course</th><th>Section</th><th>Attendance</th></tr></thead><tbody>{rows.map((row) => <tr key={row.section}><td>{row.course}</td><td>{row.section}</td><td>{row.attendance.toFixed(1)}%</td></tr>)}</tbody></table></div>
    </>}
  </div>;
}

function StudentResults({ sections, profile }: { sections: CourseSection[]; profile: StudentProfile | null }) {
  const rows = sections.flatMap((section) => {
    const student = ownStudent(section, profile);
    return student ? studentMarks(section, student).map((mark) => ({ ...mark, sectionCode: section.code, course: section.course })) : [];
  });
  return <div className="page-wrap module-page">
    <ModuleHeading eyebrow="Recorded academic results" title="Results & Grades" copy="Subject results are drawn from marks saved for your own authenticated profile. Grade and CGPA scales are not configured in the current data model." />
    {rows.length ? <section className="panel performance-table-panel"><div className="panel-kicker"><ClipboardList size={16} /> Subject marks</div><div className="table-shell"><table className="student-table"><thead><tr><th>Course</th><th>Section</th><th>Subject</th><th>Marks</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.sectionCode}-${row.subject}-${index}`}><td>{row.course}</td><td>{row.sectionCode}</td><td>{row.subject}</td><td>{row.score.toFixed(1)}%</td></tr>)}</tbody></table></div><p className="muted">Semester result history, letter grades, and CGPA are not available in the active backend schema.</p></section>
      : <ModuleEmpty title="No results available yet" message={sections.length ? 'No subject marks have been recorded for your enrolled sections.' : 'Results appear after faculty enrolls you and records marks.'} />}
    {sections.map((section) => <AssessmentPanel key={section.id} sectionId={section.id} subjects={section.subjects} studentUid={profile?.id} mode="student" />)}
  </div>;
}

function ModuleRequestError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const status = error instanceof ApiResponseError ? error.status : null;
  const title = status === 401 ? 'Authentication needs attention'
    : status === 403 ? 'This account is not authorized'
      : 'Could not load course data';
  return <div className="page-wrap module-page">
    <ModuleHeading eyebrow="Workspace connection" title="Course data unavailable" copy="LearnPulse could not confirm the authorized course data response. This is an error state, not an empty enrollment result." />
    <section className="panel module-empty module-error" role="alert"><div className="panel-kicker"><AlertTriangle size={16} /> {title}</div><h2>{error.message}</h2><p>{status === 401 ? 'Your Firebase session may need refreshing. Retry once to request a fresh ID token; if it still fails, sign in again.' : status === 403 ? 'The backend denied access based on the trusted role or account state. Contact an administrator if this is unexpected.' : 'Check your connection and server, then retry. No course data was changed.'}</p><button className="primary-button" onClick={onRetry}>Retry loading data <ArrowUpRight size={16} /></button></section>
  </div>;
}

function ownStudent(section: CourseSection, profile: StudentProfile | null) {
  return profile ? section.students.find((student) => student.id === profile.id) : undefined;
}

function studentMarks(section: CourseSection, student?: StudentRecord) {
  if (!student) return [];
  return section.subjects.flatMap((subject) => {
    const value = student.marks[subject];
    return Number.isFinite(value) ? [{ subject, score: value, sectionAverage: subjectAverage(section, subject) }] : [];
  });
}

function StudentOverview({ sections, profile }: { sections: CourseSection[]; profile: StudentProfile | null }) {
  const ownRows = sections.flatMap((section) => {
    const student = ownStudent(section, profile);
    return student ? [{ section, student }] : [];
  });
  const scores = ownRows.flatMap(({ section, student }) => studentMarks(section, student).map(({ score }) => score));
  const attendance = ownRows.map(({ student }) => student.attendance).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const subjectCount = new Set(sections.flatMap((section) => section.subjects)).size;
  return <div className="page-wrap module-page">
    <ModuleHeading eyebrow="Student overview" title={`Welcome${profile?.name ? `, ${profile.name.split(' ')[0]}` : ' back'}.`} copy="Your account, enrolled courses, and verified learning data in one place." />
    <section className="identity-banner"><div className="avatar orange large">{initials(profile?.name || 'Student')}</div><div><span>Student account</span><h2>{profile?.name || 'Student'}</h2><p>{profile?.rollNo || 'Profile linked to your Firebase account'}</p></div><div className="identity-course"><span>Registered email</span><b>{profile?.email || 'Not provided'}</b></div></section>
    <section className="metrics-grid student-metrics">
      <Metric label="Enrolled courses" value={String(sections.length)} detail="Authorized course sections" icon={<BookOpen size={16} />} tone="orange" />
      <Metric label="Enrolled subjects" value={sections.length ? String(subjectCount) : '—'} detail={sections.length ? 'Subjects listed in your sections' : 'No course data available'} icon={<ClipboardList size={16} />} />
      <Metric label="Marks available" value={String(scores.length)} detail={scores.length ? `Across ${ownRows.length} section${ownRows.length === 1 ? '' : 's'}` : 'No marks have been uploaded'} icon={<BarChart3 size={16} />} />
      <Metric label="Average score" value={scores.length ? `${(scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(1)}%` : '—'} detail={scores.length ? 'Based on your available marks' : 'Displayed when marks exist'} icon={<Activity size={16} />} tone="soft" />
      <Metric label="Attendance" value={attendance.length ? `${(attendance.reduce((sum, value) => sum + value, 0) / attendance.length).toFixed(1)}%` : '—'} detail={attendance.length ? 'Average of reported attendance' : 'No attendance data available'} icon={<CalendarDays size={16} />} tone={attendance.some((value) => value < 75) ? 'alert' : 'good'} />
      <Metric label="Pending assignments" value="—" detail="No assignment data source" icon={<ClipboardList size={16} />} />
    </section>
    <div className="section-heading-row section-gap"><div><div className="eyebrow">Your courses</div><h2>Course overview</h2></div></div>
    {sections.length ? <div className="module-card-grid">{sections.map((section) => {
      const student = ownStudent(section, profile);
      const marks = studentMarks(section, student);
      return <article className="panel module-course-card" key={section.id}><div className="panel-kicker"><BookOpen size={15} /> {section.code}</div><h3>{section.course || section.name}</h3><p>{section.name} · {section.term}</p><div className="detail-list"><div><span>Faculty</span><b>{section.faculty || 'Not listed'}</b></div><div><span>Subjects</span><b>{section.subjects.length || 'Not listed'}</b></div><div><span>Marks</span><b>{marks.length ? `${marks.length} available` : 'Not uploaded'}</b></div></div></article>;
    })}</div> : <ModuleEmpty title="No courses are linked to your account yet." message="Your dashboard is ready. Ask your faculty to add your student account to a course section; no course or enrollment data has been created for you." />}
    <div className="overview-lower-grid">
      <section className="panel overview-activity"><div className="panel-kicker"><CalendarDays size={15} /> Timetable & events</div><h2>Upcoming academic activity</h2><p>Class schedules, examination dates, and assignment deadlines are not available in the current backend data model.</p><div className="overview-links"><Link to="/timetable">Open timetable</Link><Link to="/examinations">Examinations</Link><Link to="/assignments">Assignments</Link></div></section>
      <section className="panel overview-activity"><div className="panel-kicker"><Activity size={15} /> Recent activity</div><h2>Course updates</h2><p>Submitted work, material view history, and academic announcements are not currently recorded by the application.</p><div className="overview-links"><Link to="/materials">Study materials</Link><Link to="/notifications">Notifications</Link></div></section>
      <section className="panel overview-activity"><div className="panel-kicker"><Sparkles size={15} /> Academic support</div><h2>Learning assistance</h2><p>Request evidence-based learning guidance when marks are available for your enrolled section.</p><div className="overview-links"><Link to="/ai-assistant">AI study assistant</Link><Link to="/learning-signals">Learning signals</Link></div></section>
    </div>
  </div>;
}

function StudentPerformance({ sections, profile }: { sections: CourseSection[]; profile: StudentProfile | null }) {
  const results = sections.flatMap((section) => {
    const student = ownStudent(section, profile);
    return student ? studentMarks(section, student).map((mark) => ({ ...mark, sectionCode: section.code })) : [];
  });
  const attendance = sections.flatMap((section) => {
    const student = ownStudent(section, profile);
    return student && typeof student.attendance === 'number' ? [{ section: section.code, attendance: student.attendance }] : [];
  });
  return <div className="page-wrap module-page">
    <ModuleHeading eyebrow="Personal analytics" title="Performance Analytics" copy="Only marks and attendance returned for your authenticated student profile are shown here." />
    {!sections.length && <ModuleEmpty title="No enrolled course data yet" message="Once faculty enrolls your account, your marks and attendance will appear here." />}
    {sections.length > 0 && !results.length && !attendance.length && <ModuleEmpty title="Performance data is not available yet" message="Your profile is linked, but no marks or attendance have been uploaded for your enrolled sections." />}
    {results.length > 0 && <>
      <section className="panel chart-panel"><div className="section-heading-row"><div><div className="panel-kicker"><BarChart3 size={16} /> Marks by subject</div><h2>Your recorded results</h2></div></div>
        <div className="performance-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={results} margin={{ top: 12, right: 12, left: -12, bottom: 28 }}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="subject" interval={0} angle={-15} textAnchor="end" /><YAxis domain={[0, 100]} /><Tooltip formatter={(value) => [`${value}%`, 'Your mark']} /><Bar dataKey="score" name="Your mark" fill="#d8793d" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div>
      </section>
      <section className="panel performance-table-panel"><div className="panel-kicker"><Activity size={16} /> Subject details</div><div className="table-shell"><table className="student-table"><thead><tr><th>Course</th><th>Subject</th><th>Your mark</th><th>Section average</th></tr></thead><tbody>{results.map((result, index) => <tr key={`${result.sectionCode}-${result.subject}-${index}`}><td>{result.sectionCode}</td><td>{result.subject}</td><td>{result.score.toFixed(1)}%</td><td>{Number.isFinite(result.sectionAverage) ? `${result.sectionAverage.toFixed(1)}%` : '—'}</td></tr>)}</tbody></table></div></section>
    </>}
    {attendance.length > 0 && <section className="panel attendance-list"><div className="panel-kicker"><CalendarDays size={16} /> Attendance</div>{attendance.map((item) => <div className="attendance-row" key={item.section}><span>{item.section}</span><b>{item.attendance.toFixed(1)}%</b></div>)}</section>}
  </div>;
}

function StudentCourses({ sections, profile }: { sections: CourseSection[]; profile: StudentProfile | null }) {
  return <div className="page-wrap module-page">
    <ModuleHeading eyebrow="Enrolled course sections" title="My Courses" copy="Course sections are returned by the backend only when your Firebase UID is enrolled." />
    {sections.length ? <div className="module-card-grid">{sections.map((section) => {
      const student = ownStudent(section, profile);
      const marks = studentMarks(section, student);
      return <article className="panel module-course-card" key={section.id}>
        <div className="panel-kicker"><BookOpen size={15} /> {section.code}</div>
        <h3>{section.course || section.name}</h3>
        <p>{section.name} · {section.term}</p>
        <div className="detail-list"><div><span>Faculty</span><b>{section.faculty || 'Not listed'}</b></div><div><span>Section</span><b>{section.code}</b></div><div><span>Subjects</span><b>{section.subjects.length || 'Not listed'}</b></div><div><span>Recorded marks</span><b>{marks.length || 'Not available'}</b></div><div><span>Study materials</span><b>{section.materials.length}</b></div></div>
        {section.materials.length > 0 && <div className="course-material-preview"><b>Available materials</b>{section.materials.slice(0, 3).map((material) => <p key={material.id}>{material.name} · {material.subject} · {material.type}</p>)}</div>}
      </article>;
    })}</div> : <ModuleEmpty title="No courses are linked to your account yet" message="Ask your faculty to add your student account to a course section. Your course page remains available; no courses or enrollments were created." />}
  </div>;
}

function StudentCourseLibrary({ sections }: { sections: CourseSection[] }) {
  const materials = sections.flatMap((section) => section.materials.map((material) => ({ section, material })));
  const [downloadingId, setDownloadingId] = useState('');
  const [error, setError] = useState('');
  const download = async (fileId: string, fileName: string) => {
    setDownloadingId(fileId);
    setError('');
    try {
      const blob = await downloadCourseMaterial(fileId);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = fileName;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The course material could not be downloaded.');
    } finally {
      setDownloadingId('');
    }
  };
  return <div className="page-wrap module-page">
    <ModuleHeading eyebrow="Authorized course materials" title="Study Materials" copy="Browse and download private resources from course sections linked to your student account." />
    {error && <div className="login-notice" role="alert">{error}</div>}
    {materials.length ? <div className="module-card-grid">{materials.map(({ section, material }) => <article className="panel module-course-card" key={`${section.id}-${material.id}`}><div className="panel-kicker"><Library size={15} /> {material.type}</div><h3>{material.name}</h3><p>{material.subject} · {section.code} · {section.course}</p><div className="resource-meta"><span>{material.source}</span>{material.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>{material.excerpt && <details className="resource-excerpt"><summary>View available excerpt</summary><p>{material.excerpt}</p></details>}{material.fileId ? <button className="secondary-button" type="button" disabled={downloadingId === material.fileId} onClick={() => { void download(material.fileId!, material.name); }}>{downloadingId === material.fileId ? 'Downloading…' : 'Download securely'}</button> : <p className="muted resource-unavailable">This legacy item has no private stored file.</p>}</article>)}</div>
      : <ModuleEmpty title="No course materials available" message={sections.length ? 'Your enrolled sections do not currently have materials in the course library.' : 'Materials will appear after faculty enrolls you in a section and adds resources.'} />}
  </div>;
}

function StudentLearningSignals({ sections, profile, assistantMode = false }: { sections: CourseSection[]; profile: StudentProfile | null; assistantMode?: boolean }) {
  const [selectedId, setSelectedId] = useState(sections[0]?.id ?? '');
  const [review, setReview] = useState<AiReview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!sections.some((section) => section.id === selectedId)) setSelectedId(sections[0]?.id ?? '');
    setReview(null);
    setError('');
  }, [sections, selectedId]);
  const section = sections.find((item) => item.id === selectedId);
  const student = section ? ownStudent(section, profile) : undefined;
  const marks = section && student ? studentMarks(section, student) : [];
  const insight = section && student && marks.length ? insightFor(section, student) : null;
  const runReview = async () => {
    if (!section || !student || !marks.length) return;
    setLoading(true);
    setError('');
    try { setReview(await requestGroqReview(section, student)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Learning review request failed.'); }
    finally { setLoading(false); }
  };
  return <div className="page-wrap module-page">
    <ModuleHeading eyebrow={assistantMode ? 'Course-aware academic support' : 'Evidence-based guidance'} title={assistantMode ? 'AI Study Assistant' : 'Learning Signals'} copy={assistantMode ? 'Request a structured study review grounded in your own recorded marks and authorized course materials. The current Groq API does not provide free-form chat or quiz generation.' : 'Insights are shown only when supported by your actual recorded marks, attendance, and course materials.'} />
    {!sections.length ? <ModuleEmpty title="Learning signals need course data" message="No course sections are linked to your account. Ask faculty to enroll you; the system will not create sample data." /> : <>
      {sections.length > 1 && <label className="select-wrap module-section-select"><span>Course section</span><select value={section?.id ?? ''} onChange={(event) => setSelectedId(event.target.value)}>{sections.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select><ChevronDown size={15} /></label>}
      {!student ? <ModuleEmpty title="Your section profile is unavailable" message="The authorized course response did not include a student record linked to your Firebase UID. Contact an administrator; no other roster entry is displayed." />
        : !marks.length ? <ModuleEmpty title="No learning signals yet" message="Learning insights require recorded marks. Attendance alone does not produce a performance score or invented recommendation." />
          : insight && <><section className="metrics-grid student-metrics"><Metric label="Recorded average" value={`${insight.overall.toFixed(1)}%`} detail={`${marks.length} subject marks`} icon={<Activity size={16} />} tone="orange" /><Metric label="Attendance" value={student.attendance === undefined ? '—' : `${student.attendance}%`} detail={student.attendance === undefined ? 'No attendance data' : 'Recorded for this section'} icon={<CalendarDays size={16} />} /><Metric label="Strongest subject" value={insight.bestSubject} detail={`${insight.bestScore.toFixed(1)}%`} icon={<CheckCircle2 size={16} />} tone="good" /><Metric label="Focus area" value={insight.weakSubject} detail={`${insight.weakScore.toFixed(1)}%`} icon={<Target size={16} />} tone="soft" /></section>
            <section className="workspace-grid signals-grid"><div className="panel personal-panel"><div className="panel-kicker"><Sparkles size={16} /> Data-supported summary</div><h2>{insight.strengths[0]}</h2><p>{insight.weaknesses[0]}</p>{insight.attendanceAlert && <p className="signal-callout">{insight.attendanceAlert}</p>}<h3>Relevant course materials</h3>{recommendMaterials(section!, student).length ? <ul className="signal-material-list">{recommendMaterials(section!, student).map(({ material, reason }) => <li key={material.id}><b>{material.name}</b><span>{reason}</span></li>)}</ul> : <p>No course materials currently match this data.</p>}<button className="primary-button groq-button" onClick={() => { void runReview(); }} disabled={loading}>{loading ? 'Generating review…' : review ? 'Retry / refresh AI review' : 'Request AI learning review'} <Sparkles size={15} /></button>{error && <div className="ai-state error-state" role="alert"><b>AI review unavailable</b><span>{error}</span><button className="text-button" onClick={() => { void runReview(); }} disabled={loading}>Retry</button></div>}</div><div className="panel">{review ? <AiReview review={review} error="" materials={section!.materials} /> : <><div className="panel-kicker"><ShieldCheck size={16} /> Privacy and evidence</div><h3>Signals use your section data</h3><p>Your review request is authorized by the backend using your verified Firebase identity and enrolled section. No other student's marks are included in this student view.</p></>}</div></section>
          </>}
    </>}
  </div>;
}

function FacultyOverview({ sections, onOpenSection }: { sections: CourseSection[]; onOpenSection: (id: string) => void }) {
  const scoredStudents = sections.flatMap((section) => section.students.map((student) => ({ section, student })).filter(({ section, student }) => studentMarks(section, student).length > 0));
  const averages = scoredStudents.map(({ section, student }) => studentAverage(student, section.subjects));
  const lowAttendance = sections.flatMap((section) => section.students.filter((student) => student.attendance !== undefined && student.attendance < 75));
  return <div className="page-wrap module-page">
    <ModuleHeading eyebrow="Faculty command center" title="Overview" copy="A live summary of course sections assigned to your authenticated faculty account." />
    <section className="metrics-grid"><Metric label="Assigned sections" value={String(sections.length)} detail="Verified against your faculty UID" icon={<BookOpen size={16} />} tone="orange" /><Metric label="Students in view" value={String(sections.reduce((sum, section) => sum + section.students.length, 0))} detail="Across your assigned sections" icon={<Users size={16} />} /><Metric label="Recorded average" value={averages.length ? `${(averages.reduce((sum, value) => sum + value, 0) / averages.length).toFixed(1)}%` : '—'} detail={averages.length ? 'Based on students with marks' : 'No marks available yet'} icon={<Activity size={16} />} /><Metric label="Attendance alerts" value={String(lowAttendance.length)} detail="Below 75% where attendance exists" icon={<AlertTriangle size={16} />} tone={lowAttendance.length ? 'alert' : 'good'} /></section>
    {sections.length ? <><div className="section-heading-row section-gap"><div><div className="eyebrow">Your courses</div><h2>Assigned sections</h2></div><button className="text-button" onClick={() => onOpenSection(sections[0].id)}>Open student monitoring <ArrowUpRight size={14} /></button></div><div className="module-card-grid">{sections.map((section) => <article className="panel module-course-card" key={section.id}><div className="panel-kicker"><BookOpen size={15} /> {section.code}</div><h3>{section.course}</h3><p>{section.name} · {section.term}</p><div className="detail-list"><div><span>Students</span><b>{section.students.length}</b></div><div><span>Subjects</span><b>{section.subjects.length || 'No marks yet'}</b></div><div><span>Materials</span><b>{section.materials.length}</b></div></div><button className="secondary-button" onClick={() => onOpenSection(section.id)}>Open section monitoring</button></article>)}</div></>
      : <ModuleEmpty title="No assigned course sections" message="Only sections assigned to your authenticated faculty UID are shown. Ask an administrator to create a class and assign it to your account." />}
  </div>;
}

function FacultyEmptyModule({ title, message, onCreate }: { title: string; message: string; onCreate?: () => void }) {
  return <div className="page-wrap module-page"><ModuleHeading eyebrow="Faculty workspace" title={title} copy="This module is scoped to sections assigned to your authenticated faculty account." /><ModuleEmpty title={title === 'Student Monitoring' ? 'No assigned sections to monitor' : 'No sections to manage yet'} message={message} action={onCreate && <button className="primary-button" onClick={onCreate}>Create course section <ArrowUpRight size={16} /></button>} /></div>;
}

function FacultyLearningSignals({ sections }: { sections: CourseSection[] }) {
  const [sectionId, setSectionId] = useState(sections[0]?.id ?? '');
  const [studentId, setStudentId] = useState('');
  const [focused, setFocused] = useState<StudentRecord | null>(null);
  useEffect(() => {
    if (!sections.some((section) => section.id === sectionId)) setSectionId(sections[0]?.id ?? '');
    setStudentId('');
    setFocused(null);
  }, [sections, sectionId]);
  const section = sections.find((item) => item.id === sectionId);
  const students = section?.students.filter((student) => studentMarks(section, student).length) ?? [];
  return <div className="page-wrap module-page">
    <ModuleHeading eyebrow="Authorized faculty insights" title="Learning Signals" copy="Review student signals and request AI analysis only for students in sections assigned to your faculty UID." />
    {!section ? <ModuleEmpty title="No assigned sections available" message="Faculty learning signals are restricted to sections assigned to your account." /> : <>
      {sections.length > 1 && <label className="select-wrap module-section-select"><span>Assigned section</span><select value={section.id} onChange={(event) => setSectionId(event.target.value)}>{sections.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select><ChevronDown size={15} /></label>}
      {students.length ? <section className="panel"><div className="panel-kicker"><Target size={16} /> Students with recorded marks</div><div className="table-shell"><table className="student-table"><thead><tr><th>Student</th><th>Average</th><th>Attendance</th><th>Signal</th><th /></tr></thead><tbody>{students.map((student) => { const insight = insightFor(section, student); return <tr key={student.id} onClick={() => { setStudentId(student.id); setFocused(student); }} tabIndex={0} onKeyDown={(event) => event.key === 'Enter' && (setStudentId(student.id), setFocused(student))}><td>{student.name} · {student.rollNo}</td><td>{insight.overall.toFixed(1)}%</td><td>{student.attendance === undefined ? '—' : `${student.attendance}%`}</td><td>{insight.group}</td><td><button className="text-button" onClick={(event) => { event.stopPropagation(); setStudentId(student.id); setFocused(student); }}>Review</button></td></tr>; })}</tbody></table></div></section>
        : <ModuleEmpty title="No marks available for review" message="This assigned section has no recorded student marks, so performance-based insights are not generated." />}
      {focused && <ReportCard key={`${section.id}-${studentId}`} section={section} student={focused} onClose={() => setFocused(null)} />}
    </>}
  </div>;
}

function LoginPage({ role, onRoleChange, onSignIn, authConfigured, authNotice }: { role: Role; onRoleChange: (role: Role) => void; onSignIn: (email: string, password: string) => Promise<string | null>; authConfigured: boolean; authNotice: string }) {
  const [showPassword, setShowPassword] = useState(false);
  const [notice, setNotice] = useState(authNotice);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSendingReset, setIsSendingReset] = useState(false);

  useEffect(() => {
    setNotice(authNotice);
  }, [authNotice]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice('');
    setIsSubmitting(true);
    const formData = new FormData(event.currentTarget);
    try {
      const error = await onSignIn(String(formData.get('email') ?? '').trim(), String(formData.get('password') ?? ''));
      if (error) setNotice(error);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Firebase sign-in failed. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePasswordReset = async () => {
    if (!auth) {
      setNotice(firebaseConfigurationMessage);
      return;
    }
    const email = (document.querySelector<HTMLInputElement>('input[name="email"]')?.value ?? '').trim();
    if (!email) {
      setNotice('Enter your email address first, then request a password reset.');
      return;
    }
    setIsSendingReset(true);
    try {
      await sendPasswordResetEmail(email, `${window.location.origin}/login`);
      setNotice('Password reset email sent. Check your inbox and follow the reset link.');
    } catch (error) {
      setNotice(error instanceof Error ? friendlyAuthError(error.message) : 'Password reset could not be sent.');
    } finally {
      setIsSendingReset(false);
    }
  };

  return <main className="login-page">
    <section className="login-story">
      <a className="brand login-brand" href="#" onClick={(event) => event.preventDefault()}>
        <div className="brand-mark"><Activity size={18} /></div>
        <div><strong>LearnPulse</strong><span>Education intelligence</span></div>
      </a>
      <div className="login-story-content">
        <div className="eyebrow"><span className="live-dot" /> Your learning, in focus</div>
        <h1>Small signals.<br /><em>Big progress.</em></h1>
        <p>One place for students to understand their progress and for faculty to guide what comes next.</p>
        <div className="login-story-stats">
          <div><strong>01</strong><span>See progress clearly</span></div>
          <div><strong>02</strong><span>Focus on what matters</span></div>
          <div><strong>03</strong><span>Keep learning forward</span></div>
        </div>
      </div>
      <div className="login-story-footer"><ShieldCheck size={15} /><span>Designed for focused, explainable learning support.</span></div>
    </section>
    <section className="login-panel">
      <div className="login-card">
        <div className="login-mobile-brand brand">
          <div className="brand-mark"><Activity size={18} /></div>
          <div><strong>LearnPulse</strong><span>Education intelligence</span></div>
        </div>
        <div className="eyebrow">Welcome back</div>
        <h2>Sign in to your<br /><em>workspace.</em></h2>
        <p className="login-intro">Choose your account type to continue.</p>
        <div className="login-role-tabs" role="tablist" aria-label="Choose account type">
          <button type="button" role="tab" aria-selected={role === 'student'} className={role === 'student' ? 'active' : ''} onClick={() => { onRoleChange('student'); setNotice(''); }}>
            <GraduationCap size={17} /><span>Student</span>
          </button>
          <button type="button" role="tab" aria-selected={role === 'faculty'} className={role === 'faculty' ? 'active' : ''} onClick={() => { onRoleChange('faculty'); setNotice(''); }}>
            <UserRound size={17} /><span>Faculty</span>
          </button>
          <button type="button" role="tab" aria-selected={role === 'admin'} className={role === 'admin' ? 'active' : ''} onClick={() => { onRoleChange('admin'); setNotice(''); }}>
            <ShieldCheck size={17} /><span>Admin</span>
          </button>
        </div>
        <form className="login-form" onSubmit={handleSubmit}>
          <label>
            <span>{role === 'student' ? 'Student email' : role === 'faculty' ? 'Faculty email' : 'Administrator email'}</span>
            <div className="login-input-wrap"><Mail size={17} /><input name="email" type="email" autoComplete="username" placeholder="name@university.edu" required /></div>
          </label>
          <label>
            <span>Password</span>
            <div className="login-input-wrap"><LockKeyhole size={17} /><input name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="Enter your password" required /><button className="password-toggle" type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
          </label>
          <div className="login-form-meta">
            <button type="button" className="text-button" onClick={handlePasswordReset} disabled={isSendingReset || !authConfigured}>{isSendingReset ? 'Sending reset…' : 'Forgot password?'}</button>
            <span className="session-note"><LockKeyhole size={13} /> Firebase secures your session</span>
          </div>
          {notice && <div className="login-notice" role="status">{notice}</div>}
          <button className="login-submit" type="submit" disabled={isSubmitting || !authConfigured}>{isSubmitting ? 'Signing in…' : 'Sign in'} {!isSubmitting && <ArrowUpRight size={17} />}</button>
        </form>
        <div className="login-divider"><span>or</span></div>
        {role === 'student' ? <Link to="/register" className="demo-entry-button">Create student account <ArrowUpRight size={15} /></Link> : <div className="login-footnote">{role === 'faculty' ? 'Faculty accounts are created by an administrator.' : 'Administrator accounts are provisioned through a trusted server-side process.'} Sign-in access is determined by the trusted Firestore role.</div>}
        <p className="login-footnote">{authConfigured ? (role === 'student' ? 'Student accounts can self-register. Faculty and Admin accounts must be provisioned securely.' : 'This account type cannot self-register; the server verifies its trusted role after sign-in.') : firebaseConfigurationMessage}</p>
      </div>
    </section>
  </main>;
}

function RegisterPage({ onRegister, onRetryProfileSetup, profileSetupPending, authConfigured, recoveryNotice }: { onRegister: (name: string, email: string, password: string) => Promise<{ error?: string; message?: string; signedIn?: boolean }>; onRetryProfileSetup: () => Promise<string | null>; profileSetupPending: boolean; authConfigured: boolean; recoveryNotice: string }) {
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [notice, setNotice] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice('');
    const formData = new FormData(event.currentTarget);
    const name = String(formData.get('name') ?? '').trim();
    const email = String(formData.get('email') ?? '').trim();
    const password = String(formData.get('password') ?? '');
    const confirmPassword = String(formData.get('confirmPassword') ?? '');

    if (!name || !email || !password) {
      setNotice('Please complete all fields before registering.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setNotice('Enter a valid email address.');
      return;
    }
    if (password.length < 8) {
      setNotice('Choose a password with at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setNotice('Passwords do not match. Please re-enter them.');
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await onRegister(name, email, password);
      if (response.error) setNotice(response.error);
      else if (response.message) setNotice(response.message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Registration failed. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleProfileSetupRetry = async () => {
    setIsSubmitting(true);
    setNotice('Retrying secure student profile setup…');
    try {
      const error = await onRetryProfileSetup();
      if (error) setNotice(error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return <main className="login-page">
    <section className="login-story">
      <a className="brand login-brand" href="#" onClick={(event) => event.preventDefault()}>
        <div className="brand-mark"><Activity size={18} /></div>
        <div><strong>LearnPulse</strong><span>Education intelligence</span></div>
      </a>
      <div className="login-story-content">
        <div className="eyebrow"><span className="live-dot" /> Student onboarding</div>
        <h1>Create your<br /><em>student access.</em></h1>
        <p>Register with your university email so your profile can be linked to the faculty roster and materials.</p>
        <div className="login-story-stats">
          <div><strong>01</strong><span>Verified student role</span></div>
          <div><strong>02</strong><span>Secure email access</span></div>
          <div><strong>03</strong><span>Faculty-linked dashboard</span></div>
        </div>
      </div>
      <div className="login-story-footer"><ShieldCheck size={15} /><span>Faculty and student roles are validated against the Firestore user profiles.</span></div>
    </section>
    <section className="login-panel">
      <div className="login-card">
        <div className="login-mobile-brand brand">
          <div className="brand-mark"><Activity size={18} /></div>
          <div><strong>LearnPulse</strong><span>Education intelligence</span></div>
        </div>
        <div className="eyebrow">Student sign up</div>
        <h2>Register for the<br /><em>student portal.</em></h2>
        <form className="login-form" onSubmit={handleSubmit} noValidate>
          <label>
            <span>Full name</span>
            <div className="login-input-wrap"><UserRound size={17} /><input name="name" type="text" placeholder="Student name" autoComplete="name" required /></div>
          </label>
          <label>
            <span>Email</span>
            <div className="login-input-wrap"><Mail size={17} /><input name="email" type="email" autoComplete="username" placeholder="name@university.edu" required /></div>
          </label>
          <label>
            <span>Password</span>
            <div className="login-input-wrap"><LockKeyhole size={17} /><input name="password" type={showPassword ? 'text' : 'password'} autoComplete="new-password" placeholder="At least 8 characters" required /><button className="password-toggle" type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
          </label>
          <label>
            <span>Confirm password</span>
            <div className="login-input-wrap"><LockKeyhole size={17} /><input name="confirmPassword" type={showConfirm ? 'text' : 'password'} autoComplete="new-password" placeholder="Repeat your password" required /><button className="password-toggle" type="button" onClick={() => setShowConfirm(!showConfirm)} aria-label={showConfirm ? 'Hide password confirmation' : 'Show password confirmation'}>{showConfirm ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
          </label>
          {notice && <div className="login-notice" role="status">{notice}</div>}
          {profileSetupPending && recoveryNotice && <div className="login-notice" role="status">{recoveryNotice}</div>}
          <button className="login-submit" type="submit" disabled={isSubmitting || !authConfigured || profileSetupPending}>{isSubmitting ? 'Creating account…' : profileSetupPending ? 'Account created' : 'Create student account'} {!isSubmitting && !profileSetupPending && <ArrowUpRight size={17} />}</button>
          {profileSetupPending && <><p className="login-footnote">The existing Firebase account will be kept. Retry uses its current session and does not create another account.</p><button className="secondary-button" type="button" onClick={() => { void handleProfileSetupRetry(); }} disabled={isSubmitting}>{isSubmitting ? 'Retrying profile setup…' : 'Retry profile setup'}</button></>}
        </form>
        <div className="login-divider"><span>or</span></div>
        <Link to="/login" className="demo-entry-button" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>Back to sign in <ArrowUpRight size={15} /></Link>
        <p className="login-footnote">{authConfigured ? 'Your student role and profile are provisioned securely after account creation.' : firebaseConfigurationMessage}</p>
      </div>
    </section>
  </main>;
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function SectionSelect({ section, sections, onSection }: { section: CourseSection; sections: CourseSection[]; onSection: (id: string) => void }) {
  return <label className="select-wrap"><span>Active section</span><select value={section.id} onChange={(event) => onSection(event.target.value)}>{sections.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select><ChevronDown size={15} /></label>;
}

function Metric({ label, value, detail, tone = 'default', icon }: { label: string; value: string; detail: string; tone?: string; icon: ReactNode }) {
  return <div className={`metric-card ${tone}`}><div className="metric-top"><span>{label}</span><span className="metric-icon">{icon}</span></div><strong>{value}</strong><small>{detail}</small></div>;
}

function FacultyView({ section, sections, onSection, onUpdate, mode = 'monitoring' }: { section: CourseSection; sections: CourseSection[]; onSection: (id: string) => void; onUpdate: (section: CourseSection) => Promise<boolean>; mode?: 'monitoring' | 'courses' | 'materials' | 'marks' | 'performance' }) {
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('All students');
  const [focused, setFocused] = useState<StudentRecord | null>(null);
  const [uploadNotice, setUploadNotice] = useState('');
  const [editingDetails, setEditingDetails] = useState(false);
  const [draft, setDraft] = useState(section);
  useEffect(() => { setDraft(section); setEditingDetails(false); setFocused(null); }, [section.id]);
  const stats = sectionStats(section);
  const scoredStudents = section.students.filter((student) => studentMarks(section, student).length > 0);
  const hasMarks = (student: StudentRecord) => studentMarks(section, student).length > 0;
  const lowAttendance = section.students.filter((student) => student.attendance !== undefined && student.attendance < 75);
  const rows = useMemo(() => section.students.map((student) => ({ student, insight: insightFor(section, student) }))
    .filter(({ student, insight }) => `${student.name} ${student.rollNo}`.toLowerCase().includes(query.toLowerCase())
      && (activeFilter === 'All students' || insight.group === activeFilter || (activeFilter === 'Attendance < 75%' && (student.attendance ?? 100) < 75))), [section, query, activeFilter]);

  const parseMarks = async (file: File) => {
    if (file.size > 20 * 1024 * 1024) {
      setUploadNotice('Marks spreadsheets must be 20 MB or smaller.');
      return;
    }
    try {
      const XLSX = await import('xlsx');
      const isCsv = file.name.toLowerCase().endsWith('.csv');
      const workbook = isCsv
        ? XLSX.read(await file.text(), { type: 'string', raw: false })
        : XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const records = XLSX.utils.sheet_to_json(firstSheet, { defval: '' }) as Record<string, unknown>[];
      const parsed = parseRows(records, section.id);
      if (!parsed) { setUploadNotice('No numeric subject columns found. Include student name/roll number plus one or more mark columns.'); return; }
      const currentStudents = new Map(section.students.map((student) => [student.rollNo.toLowerCase(), student.id]));
      const students = parsed.students.map((student) => ({
        ...student,
        id: currentStudents.get(student.rollNo.toLowerCase()) ?? student.id,
      }));
      if (!await onUpdate({ ...section, students, subjects: parsed.subjects })) {
        setUploadNotice('The marks list could not be saved to Firestore. Check the message above and try again.');
        return;
      }
      setUploadNotice(`${students.length} students and ${parsed.subjects.length} subjects loaded into ${section.code}. Other sections were not changed.`);
    } catch (error) {
      setUploadNotice(error instanceof Error
        ? `That marks file could not be read. ${error.message}`
        : 'That marks file could not be read. Try a CSV or Excel workbook with a header row.');
    }
  };

  const addMaterial = async (file: File, replaceId?: string) => {
    const subject = section.subjects.find((item) => file.name.toLowerCase().includes(item.toLowerCase().split(' ')[0])) ?? 'All subjects';
    let excerpt: string | undefined;
    let excerptNotice = '';
    try { excerpt = await extractTextExcerpt(file); }
    catch (cause) { excerptNotice = cause instanceof Error ? cause.message : 'Text indexing is unavailable for this format.'; }
    try {
      await uploadCourseMaterial(section.id, file, subject, excerpt ?? '', replaceId);
      if (!await onUpdate(section)) {
        setUploadNotice('The file is securely stored, but the refreshed section could not be loaded. Refresh the page to view it.');
        return;
      }
      setUploadNotice(`${file.name} ${replaceId ? 'replaced' : 'securely stored'} in ${section.code}.${excerpt ? ' Text excerpt indexed for AI retrieval.' : ` File remains downloadable; no text excerpt was indexed${excerptNotice ? ` (${excerptNotice})` : ''}.`}`);
    } catch (cause) {
      setUploadNotice(cause instanceof Error ? cause.message : 'The course material could not be securely stored.');
    }
  };

  const removeMaterial = async (material: CourseMaterial) => {
    if (!material.fileId || !window.confirm(`Delete "${material.name}" from this class?`)) return;
    try {
      await deleteCourseMaterial(material.fileId);
      if (await onUpdate(section)) setUploadNotice(`${material.name} deleted.`);
    } catch (cause) {
      setUploadNotice(cause instanceof Error ? cause.message : 'The course material could not be deleted.');
    }
  };

  const saveDetails = async (event: FormEvent) => {
    event.preventDefault();
    if (!await onUpdate({ ...draft, code: draft.code.trim(), name: draft.name.trim(), course: draft.course.trim(), faculty: draft.faculty.trim() })) return;
    setEditingDetails(false);
    setUploadNotice(`${section.code} course details saved.`);
  };

  return <div className="page-wrap">
    <section className="hero-row"><div><div className="eyebrow"><span className="live-dot" /> {mode === 'courses' ? 'Course management' : mode === 'materials' ? 'Study material management' : mode === 'marks' ? 'Marks and grades' : mode === 'performance' ? 'Student performance' : 'Student monitoring'}</div><h1>{mode === 'courses' ? <>Manage the course<br /><em>workspace.</em></> : mode === 'materials' ? <>Study material<br /><em>library.</em></> : mode === 'marks' ? <>Marks and grades<br /><em>management.</em></> : <>See the signal behind<br /><em>every mark.</em></>}</h1><p className="hero-copy">{mode === 'courses' ? 'Manage course resources and review academic data for classes assigned to your account.' : mode === 'materials' ? 'Add private course resources to your assigned section.' : mode === 'marks' ? 'Configure assessments and record marks in your assigned section.' : 'Monitor section progress, spot weak topics early, and turn course data into a next action for every learner.'}</p></div><div className="hero-context"><SectionSelect section={section} sections={sections} onSection={onSection} /><div className="context-person"><div className="avatar orange">{initials(section.faculty)}</div><div><span>Course faculty</span><b>{section.faculty}</b></div></div></div></section>
    <div className="status-strip"><div><CheckCircle2 size={16} /><span>Section data saves securely to Firestore · marks and analytics update from the selected list</span></div><span className="strip-code">{section.code} · {section.term}</span></div>
    <section className="metrics-grid"><Metric label="Section average" value={scoredStudents.length ? `${stats.average.toFixed(1)}%` : '—'} detail={scoredStudents.length ? `Best ${stats.highest.toFixed(1)}% · lowest ${stats.lowest.toFixed(1)}%` : 'No marks recorded'} icon={<Activity size={16} />} tone="orange" /><Metric label="Students monitored" value={String(section.students.length)} detail={`${section.subjects.length} subjects in view`} icon={<Users size={16} />} /><Metric label="Need attention" value={String(scoredStudents.filter((student) => insightFor(section, student).group !== 'Best performance').length)} detail={scoredStudents.length ? 'Based on recorded marks' : 'No mark-based signals'} icon={<Target size={16} />} tone="soft" /><Metric label="Attendance watch" value={String(lowAttendance.length)} detail={lowAttendance.length ? 'Below 75% threshold' : 'No alerts in this section'} icon={<AlertTriangle size={16} />} tone={lowAttendance.length ? 'alert' : 'good'} /></section>
    <section className="workspace-grid"><div className="primary-column">
      <div className="section-heading-row"><div><div className="eyebrow">Section monitor</div><h2>Student performance</h2></div><div className="table-tools"><div className="search-box"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or roll no." /></div></div></div>
      <div className="filter-row">{['All students', 'Best performance', 'Needs a little improvement', 'Needs focused improvement', 'Attendance < 75%'].map((filter) => <button key={filter} className={activeFilter === filter ? 'filter active' : 'filter'} onClick={() => setActiveFilter(filter)}>{filter}</button>)}</div>
      <div className="table-shell"><table className="student-table"><thead><tr><th>Student</th><th>Average</th><th>Class gap</th><th>Attendance</th><th>Signal</th><th /></tr></thead><tbody>{rows.map(({ student, insight }) => <tr key={student.id} onClick={() => setFocused(student)} tabIndex={0} onKeyDown={(event) => event.key === 'Enter' && setFocused(student)}><td><div className="student-cell"><div className="mini-avatar">{initials(student.name)}</div><div><b>{student.name}</b><span>{student.rollNo}</span></div></div></td><td><strong>{hasMarks(student) ? `${insight.overall.toFixed(1)}%` : '—'}</strong><span className="cell-sub">{insight.level}</span></td><td><span className={hasMarks(student) ? insight.gap >= 0 ? 'gap positive' : 'gap negative' : 'gap'}>{hasMarks(student) ? `${insight.gap >= 0 ? '+' : ''}${insight.gap.toFixed(1)}` : '—'}</span></td><td><span className={student.attendance !== undefined && student.attendance < 75 ? 'attendance low' : 'attendance'}>{student.attendance === undefined ? '—' : `${student.attendance}%`}</span></td><td><span className={`signal ${insight.group.includes('Best') ? 'signal-good' : insight.group.includes('focused') ? 'signal-risk' : 'signal-mid'}`}>{insight.group}</span></td><td><ArrowUpRight size={15} className="row-arrow" /></td></tr>)}</tbody></table>{!rows.length && <div className="empty-state">{section.students.length ? 'No students match this filter.' : 'No student marks yet. Upload a CSV/XLSX list to populate this section.'}</div>}</div>
      <div className="section-heading-row section-gap"><div><div className="eyebrow">Subject signals</div><h2>Where the class needs support</h2></div><span className="muted">Compared with subject average</span></div><div className="subject-grid">{section.subjects.length ? section.subjects.map((subject) => { const subjectMarks = section.students.map((student) => student.marks[subject]).filter((mark) => Number.isFinite(mark)); const avg = subjectAverage(section, subject); const weakCount = subjectMarks.filter((mark) => mark < avg).length; return <div className="subject-card" key={subject}><div className="subject-icon"><BarChart3 size={17} /></div><div><b>{subject}</b><span>{subjectMarks.length ? `${weakCount} students below subject average` : 'No marks recorded'}</span></div><strong>{subjectMarks.length ? `${avg.toFixed(1)}%` : '—'}</strong><div className="progress"><i style={{ width: `${subjectMarks.length ? Math.min(avg, 100) : 0}%` }} /></div></div>; }) : <div className="empty-state">Subject analytics appear after a marks list is uploaded.</div>}</div>
    </div><aside className="secondary-column">
      <div className="panel upload-panel"><div className="panel-kicker"><UploadCloud size={16} /> Faculty uploads</div><h3>Bring the course<br /><em>into focus.</em></h3><p>Upload a marks list for this section or add course materials. Data remains separate by section.</p><label className="upload-zone"><input type="file" accept=".csv,.xlsx,.xls" onChange={(event) => event.target.files?.[0] && parseMarks(event.target.files[0])} /><FileText size={21} /><b>Upload / replace marks list</b><span>CSV or Excel · enrolled students and configured subjects only</span></label><label className="upload-zone compact"><input type="file" accept=".pdf,.ppt,.pptx,.doc,.docx,.txt" disabled={!section.subjects.length} onChange={(event) => event.target.files?.[0] && addMaterial(event.target.files[0])} /><Paperclip size={18} /><b>Add private course material</b><span>PDF, PPT/PPTX, DOC/DOCX, TXT · maximum 10 MB</span></label>{uploadNotice && <div className="upload-notice"><CheckCircle2 size={15} />{uploadNotice}</div>}</div>
      <div className="panel course-panel"><div className="panel-kicker"><BookOpen size={16} /> Course details</div>{editingDetails ? <form className="course-edit-form" onSubmit={saveDetails}><h3>Edit room and schedule</h3>{(['schedule', 'room'] as const).map((field) => <label key={field}><span>{field === 'schedule' ? 'Schedule' : 'Room'}</span><input value={draft[field]} onChange={(event) => setDraft({ ...draft, [field]: event.target.value })} /></label>)}<div className="form-actions"><button className="primary-button" type="submit">Save details</button><button className="secondary-button" type="button" onClick={() => { setDraft(section); setEditingDetails(false); }}>Cancel</button></div></form> : <><h3>{section.course}</h3><div className="detail-list"><div><span>Section</span><b>{section.code} · {section.name}</b></div><div><span>Faculty</span><b>{section.faculty}{section.facultyEmail ? ` · ${section.facultyEmail}` : ''}</b></div><div><span>Term</span><b>{section.term}</b></div><div><span>Schedule</span><b>{section.schedule || 'Not set'}</b></div><div><span>Room</span><b>{section.room || 'Not set'}</b></div></div><button className="text-button" onClick={() => setEditingDetails(true)}>Edit room and schedule <ArrowUpRight size={14} /></button></>}</div>
      <div className="panel library-panel"><div className="section-heading-row compact-row"><div><div className="panel-kicker"><Library size={15} /> Course library</div><h3>{section.materials.length} learning resources</h3></div><span className="tiny-badge">RAG-ready</span></div><div className="material-list">{section.materials.slice(0, 6).map((material) => <div className="material-row" key={material.id}><div className="material-icon"><FileText size={15} /></div><div><b>{material.name}</b><span>{material.subject} · {material.type}{material.excerpt ? ' · text indexed' : ''}</span></div>{material.fileId && <><label className="text-button">Replace<input hidden type="file" accept=".pdf,.ppt,.pptx,.doc,.docx,.txt" onChange={(event) => { const replacement = event.currentTarget.files?.[0]; if (replacement) void addMaterial(replacement, material.fileId); event.currentTarget.value = ''; }} /></label><button className="text-button" type="button" onClick={() => { void removeMaterial(material); }}>Delete</button></>}</div>)}{!section.materials.length && <div className="muted empty-materials">Add a course resource to make it available for recommendations.</div>}</div></div>
    </aside></section>
    {mode === 'marks' && <AssessmentPanel sectionId={section.id} subjects={section.subjects} students={section.students} mode="faculty" />}
    {focused && <ReportCard section={section} student={focused} onClose={() => setFocused(null)} />}
    <div className="bottom-actions"><button className="secondary-button" onClick={() => downloadCsv(section)}><Download size={15} /> Download section CSV</button><button className="secondary-button" onClick={() => downloadXlsx(section)}><Download size={15} /> Download section Excel</button></div>
  </div>;
}

function AiReview({ review, error, materials }: { review: AiReview | null; error: string; materials: CourseMaterial[] }) {
  if (error) return <div className="ai-state error-state"><b>Groq review unavailable</b><span>{error}</span><small>Numeric marks and the evidence-based local review remain available.</small></div>;
  if (!review) return null;
  return <div className="ai-review-content"><div className="ai-summary"><div className="panel-kicker"><Sparkles size={15} /> Groq detailed review{review.model ? ` · ${review.model}` : ''}</div><p>{review.summary}</p></div>{review.strengths.length > 0 && <div className="insight-block"><div className="insight-title"><CheckCircle2 size={15} /> Strengths</div>{review.strengths.map((item) => <p key={item}>{item}</p>)}</div>}{review.focusAreas.map((area, index) => <div className="ai-focus" key={`${area.subject}-${index}`}><div><b>{area.subject}</b><span>{area.evidence}</span></div><p>{area.action}</p></div>)}{review.weeklyPlan.length > 0 && <div className="ai-plan"><b>Suggested study plan</b><ol>{review.weeklyPlan.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ol></div>}{review.recommendedMaterials.length > 0 && <div className="ai-plan"><b>Retrieved course materials</b>{review.recommendedMaterials.map((item) => <div className="ai-material" key={item.materialId}><BookOpen size={14} /><span>{materials.find((material) => material.id === item.materialId)?.name ?? 'Course resource'}: {item.reason}</span></div>)}</div>}<div className="ai-followup"><b>Faculty follow-up</b><p>{review.facultyFollowUp}</p></div></div>;
}

function StudentView({ section, sections, student, onSection, onStudent }: { section: CourseSection; sections: CourseSection[]; student?: StudentRecord; onSection: (id: string) => void; onStudent: (id: string) => void }) {
  const [studentQuery, setStudentQuery] = useState('');
  const [review, setReview] = useState<AiReview | null>(null);
  const [aiError, setAiError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => { setReview(null); setAiError(''); }, [section.id, student?.id]);
  const matches = section.students.filter((candidate) => `${candidate.name} ${candidate.rollNo}`.toLowerCase().includes(studentQuery.toLowerCase()));
  const insight = student ? insightFor(section, student) : null;
  const recommendations = student ? recommendMaterials(section, student) : [];
  const runReview = async () => {
    if (!student) return;
    setLoading(true); setAiError('');
    try { setReview(await requestGroqReview(section, student)); }
    catch (error) { setAiError(error instanceof Error ? error.message : 'Could not generate the study plan.'); }
    finally { setLoading(false); }
  };

  return <div className="page-wrap student-page"><section className="hero-row"><div><div className="eyebrow"><span className="live-dot" /> Personal learning view</div><h1>Your next win<br /><em>starts here.</em></h1><p className="hero-copy">A clear view of your marks, your position in the section, and the most useful next study move.</p></div><div className="hero-context"><SectionSelect section={section} sections={sections} onSection={onSection} /><div className="student-picker"><Search size={15} /><input value={studentQuery} onChange={(event) => setStudentQuery(event.target.value)} placeholder="Find your name or roll no." aria-label="Find a student in this section" />{studentQuery && matches.length > 0 && <div className="picker-menu">{matches.slice(0, 5).map((candidate) => <button key={candidate.id} onClick={() => { onStudent(candidate.id); setStudentQuery(''); }}>{candidate.name}<span>{candidate.rollNo}</span></button>)}</div>}</div></div></section>
    {!student || !insight ? <div className="panel no-roster"><div className="panel-kicker"><Users size={16} /> Section enrollment</div><h3>No students in {section.code} yet</h3><p>Ask faculty to upload this section's marks list. After upload, choose your name from this section's roster to see your marks and course feedback.</p><div className="identity-course"><span>Course faculty</span><b>{section.faculty}</b></div><p>{section.course} · {section.term}</p></div> : <>
      <div className="identity-banner"><div className="avatar orange large">{initials(student.name)}</div><div><span>Viewing {section.code}</span><h2>{student.name}</h2><p>{section.course} · {section.term}</p></div><div className="identity-course"><span>Course faculty</span><b>{section.faculty}</b><small>{section.facultyEmail}</small></div></div>
      <section className="metrics-grid student-metrics"><Metric label="My average" value={`${insight.overall.toFixed(1)}%`} detail={`${insight.gap >= 0 ? '+' : ''}${insight.gap.toFixed(1)} vs section average`} icon={<Sparkles size={16} />} tone="orange" /><Metric label="Attendance" value={student.attendance === undefined ? '—' : `${student.attendance}%`} detail={student.attendance !== undefined && student.attendance < 75 ? 'Needs attention' : 'On track'} icon={<CalendarDays size={16} />} tone={student.attendance !== undefined && student.attendance < 75 ? 'alert' : 'good'} /><Metric label="Current signal" value={insight.group.replace('Needs ', '')} detail={insight.level} icon={<Target size={16} />} /><Metric label="Focus subject" value={insight.weakSubject} detail={`${insight.weakScore.toFixed(1)}% · next opportunity`} icon={<Brain size={16} />} tone="soft" /></section>
      <section className="student-grid"><div className="primary-column"><div className="panel personal-panel"><div className="panel-kicker"><Sparkles size={16} /> Personal performance note</div><h3>{insight.gap >= 0 ? 'Your momentum is visible.' : 'Your next improvement is specific.'}</h3><p>{insight.gap >= 0 ? `You are ${insight.gap.toFixed(1)} points above the section average. Keep your strongest habits and use the focus area below to move further ahead.` : `You are ${Math.abs(insight.gap).toFixed(1)} points below the section average. Start with ${insight.weakSubject}, then use the recommended material.`}</p><div className="signal-callout"><Target size={18} /><div><b>Recommended next action</b><span>{insight.recommendation}</span></div></div><button className="primary-button groq-button" onClick={runReview} disabled={loading}><Sparkles size={15} />{loading ? 'Building your study plan…' : review ? 'Refresh Groq study plan' : 'Get my Groq study plan'}</button><AiReview review={review} error={aiError} materials={section.materials} /></div>
      <div className="section-heading-row section-gap"><div><div className="eyebrow">Subject review</div><h2>Your marks in context</h2></div><span className="muted">Student vs section average</span></div><div className="subject-grid student-subjects">{section.subjects.map((subject) => { const score = student.marks[subject] ?? 0; const avg = subjectAverage(section, subject); const positive = score >= avg; return <div className="subject-card" key={subject}><div className={`subject-icon ${positive ? 'good' : 'risk'}`}>{positive ? <CheckCircle2 size={17} /> : <Target size={17} />}</div><div><b>{subject}</b><span>{positive ? 'Above subject average' : 'Improvement focus'}</span></div><strong>{score}%</strong><div className="progress"><i className={positive ? 'progress-good' : 'progress-risk'} style={{ width: `${Math.min(score, 100)}%` }} /></div><small>{score >= avg ? '+' : ''}{(score - avg).toFixed(1)} vs subject average</small></div>; })}</div></div>
      <aside className="secondary-column"><div className="panel recommendation-panel"><div className="panel-kicker"><Zap size={16} /> Suggested study path</div><h3>Materials selected<br /><em>for {insight.weakSubject}.</em></h3><p>Resources are retrieved from this section's course library and matched to the improvement focus.</p><div className="material-list">{recommendations.map(({ material, reason }) => <div className="recommendation-row" key={material.id}><div className="material-icon"><BookOpen size={15} /></div><div><b>{material.name}</b><span>{material.type} · {reason}</span></div><ArrowUpRight size={14} /></div>)}{!recommendations.length && <div className="muted">No course resources have been added for this section yet.</div>}</div></div>
      <div className="panel attendance-panel"><div className="panel-kicker"><ShieldCheck size={16} /> Explainable view</div><h3>What the faculty sees</h3><p>Your section comparison uses this section's marks and attendance. The AI study plan uses course details and matching materials, not hidden score changes.</p><button className="text-button" onClick={() => downloadReport(section, student, review ?? undefined)}>Download my detailed report <ArrowUpRight size={14} /></button><button className="text-button download-marks-button" onClick={() => downloadIndividualMarks(section, student)}><Download size={14} /> Download my marks CSV</button></div></aside></section>
    </>}
  </div>;
}

function ReportCard({ section, student, onClose }: { section: CourseSection; student: StudentRecord; onClose: () => void }) {
  const insight = insightFor(section, student);
  const [tab, setTab] = useState<'overview' | 'subjects' | 'groq'>('overview');
  const [review, setReview] = useState<AiReview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const hasRecordedMarks = studentMarks(section, student).length > 0;
  const recommendations = hasRecordedMarks ? recommendMaterials(section, student) : [];
  const runReview = async () => {
    if (!hasRecordedMarks) return;
    setLoading(true); setError('');
    try { setReview(await requestGroqReview(section, student)); setTab('groq'); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not generate the detailed review.'); setTab('groq'); }
    finally { setLoading(false); }
  };
  return <div className="report-overlay" role="presentation"><div className="report-drawer" role="dialog" aria-modal="true" aria-label={`Individual review for ${student.name}`}><div className="drawer-head"><div><div className="eyebrow">Individual review · {section.code}</div><h2>{student.name}</h2><span>{student.rollNo} · {section.course} · {section.faculty}</span></div><button className="icon-button" onClick={onClose} aria-label="Close review"><X size={18} /></button></div><div className="drawer-tabs"><button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview</button><button className={tab === 'subjects' ? 'active' : ''} onClick={() => setTab('subjects')}>Subject detail</button><button className={tab === 'groq' ? 'active' : ''} onClick={() => setTab('groq')}>Groq review</button></div>
    {tab === 'overview' ? <><div className="drawer-metrics"><Metric label="Average" value={hasRecordedMarks ? `${insight.overall.toFixed(1)}%` : '—'} detail={hasRecordedMarks ? `Class ${insight.classAverage.toFixed(1)}%` : 'No marks recorded'} icon={<Activity size={15} />} tone="orange" /><Metric label="Attendance" value={student.attendance === undefined ? '—' : `${student.attendance}%`} detail={insight.attendanceAlert ?? (student.attendance === undefined ? 'No attendance data' : 'Recorded attendance')} icon={<CalendarDays size={15} />} /></div><div className="insight-block"><div className="insight-title"><CheckCircle2 size={16} /> Strengths</div>{insight.strengths.length ? insight.strengths.map((item) => <p key={item}>{item}</p>) : <p>No marks are available to identify performance strengths.</p>}</div><div className="insight-block warning"><div className="insight-title"><Target size={16} /> Improvement focus</div>{insight.weaknesses.length ? insight.weaknesses.map((item) => <p key={item}>{item}</p>) : <p>No mark-based improvement areas are available yet.</p>}{hasRecordedMarks && <p className="recommendation"><b>Next action:</b> {insight.recommendation}</p>}</div><div className="review-resources"><b>Matched section materials</b>{recommendations.length ? recommendations.map(({ material, reason }) => <p key={material.id}>{material.name} — {reason}</p>) : <p>No evidence-based material matches are available yet.</p>}</div></> : tab === 'subjects' ? <div className="drawer-subjects">{section.subjects.map((subject) => { const mark = student.marks[subject]; const averageAvailable = section.students.some((entry) => Number.isFinite(entry.marks[subject])); return <div className="drawer-subject" key={subject}><div><b>{subject}</b><span>Student {Number.isFinite(mark) ? `${mark}%` : '—'} · Section {averageAvailable ? `${subjectAverage(section, subject).toFixed(1)}%` : '—'}</span></div><strong className={Number.isFinite(mark) ? mark >= subjectAverage(section, subject) ? 'text-good' : 'text-risk' : ''}>{Number.isFinite(mark) ? mark >= subjectAverage(section, subject) ? 'Compared' : 'Below average' : 'No marks'}</strong></div>; })}</div> : <>{hasRecordedMarks ? <button className="primary-button groq-button" onClick={runReview} disabled={loading}><Sparkles size={15} />{loading ? 'Reviewing marks and course resources…' : review ? 'Refresh detailed Groq review' : 'Generate detailed Groq review'}</button> : <div className="empty-state">Groq learning reviews are available after marks are recorded.</div>}<AiReview review={review} error={error} materials={section.materials} /></>}
    <div className="drawer-actions"><button className="primary-button" onClick={() => downloadIndividualMarks(section, student)}><Download size={15} /> Download individual marks</button><button className="secondary-button" onClick={() => downloadReport(section, student, review ?? undefined)}><FileText size={15} /> Download detailed report</button><button className="secondary-button" onClick={onClose}>Close review</button></div></div></div>;
}

export default App;
