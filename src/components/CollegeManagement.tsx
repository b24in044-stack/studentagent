import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Activity, CheckCircle2, LoaderCircle, Pencil, Plus, ShieldCheck, Users } from 'lucide-react';
import {
  createAdminClass,
  createAdminDepartment,
  createAdminStudent,
  createAdminSubject,
  fetchAdminCollege,
  fetchAdminFaculty,
  fetchAdminReports,
  updateAdminClass,
  updateAdminDepartment,
  updateAdminStudent,
  type AdminCollegeData,
  type AdminFaculty,
  type StudentAcademicInput,
} from '../lib/firebaseData';

type AdminPage = 'departments' | 'classes' | 'subjects' | 'students' | 'reports';
type StudentForm = {
  name: string;
  email: string;
  studentId: string;
  departmentId: string;
  btechYear: string;
  sectionId: string;
  semester: string;
  enrollmentStatus: 'active' | 'inactive';
  temporaryPassword: string;
};

const emptyStudent: StudentForm = {
  name: '',
  email: '',
  studentId: '',
  departmentId: '',
  btechYear: '1',
  sectionId: '',
  semester: '1',
  enrollmentStatus: 'active',
  temporaryPassword: '',
};

function academicInput(form: StudentForm): StudentAcademicInput {
  return {
    studentId: form.studentId.trim(),
    departmentId: form.departmentId,
    btechYear: Number(form.btechYear),
    sectionId: form.sectionId,
    semester: Number(form.semester),
    enrollmentStatus: form.enrollmentStatus,
  };
}

export default function CollegeManagement() {
  const [page, setPage] = useState<AdminPage>('departments');
  const [data, setData] = useState<AdminCollegeData | null>(null);
  const [faculty, setFaculty] = useState<AdminFaculty[]>([]);
  const [reports, setReports] = useState<Awaited<ReturnType<typeof fetchAdminReports>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [departmentName, setDepartmentName] = useState('');
  const [departmentCode, setDepartmentCode] = useState('');
  const [classForm, setClassForm] = useState({ code: '', name: '', course: 'B.Tech', departmentId: '', btechYear: '1', semester: '1', section: 'A', facultyUid: '' });
  const [editingClassId, setEditingClassId] = useState('');
  const [subjectForm, setSubjectForm] = useState({ code: '', name: '', departmentId: '', facultyUid: '', sectionIds: [] as string[] });
  const [studentForm, setStudentForm] = useState<StudentForm>(emptyStudent);
  const [editingStudentUid, setEditingStudentUid] = useState('');

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const [college, facultyResult, reportResult] = await Promise.all([
        fetchAdminCollege(),
        fetchAdminFaculty(),
        fetchAdminReports(),
      ]);
      setData(college);
      setFaculty(facultyResult.faculty);
      setReports(reportResult);
      setClassForm((current) => ({ ...current, departmentId: current.departmentId || college.departments[0]?.id || '' }));
      setSubjectForm((current) => ({ ...current, departmentId: current.departmentId || college.departments[0]?.id || '' }));
      setStudentForm((current) => ({ ...current, departmentId: current.departmentId || college.departments[0]?.id || '' }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'College records could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadData(); }, []);

  const activeFaculty = useMemo(() => faculty.filter((person) => person.status === 'active'), [faculty]);
  const availableSections = useMemo(() => (data?.sections ?? []).filter((section) =>
    section.departmentId === studentForm.departmentId
    && section.btechYear === Number(studentForm.btechYear)
    && section.semester === Number(studentForm.semester)), [data, studentForm.departmentId, studentForm.btechYear, studentForm.semester]);

  const runSave = async (operation: () => Promise<void>, successMessage: string) => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await operation();
      setNotice(successMessage);
      await loadData();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The requested change could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const submitDepartment = (event: FormEvent) => {
    event.preventDefault();
    void runSave(async () => {
      await createAdminDepartment({ name: departmentName, code: departmentCode });
      setDepartmentName('');
      setDepartmentCode('');
    }, 'Department created.');
  };

  const submitClass = (event: FormEvent) => {
    event.preventDefault();
    if (editingClassId) {
      const current = data?.sections.find((section) => section.id === editingClassId);
      if (!current) return;
      void runSave(() => updateAdminClass(editingClassId, {
        name: classForm.name,
        facultyUid: classForm.facultyUid,
        status: current.status,
      }), 'Academic class updated.');
      setEditingClassId('');
      return;
    }
    void runSave(() => createAdminClass({
      ...classForm,
      btechYear: Number(classForm.btechYear),
      semester: Number(classForm.semester),
    }), 'Academic class created.');
  };

  const submitSubject = (event: FormEvent) => {
    event.preventDefault();
    void runSave(() => createAdminSubject(subjectForm), 'Subject created and assigned to the selected classes.');
  };

  const submitStudent = (event: FormEvent) => {
    event.preventDefault();
    if (editingStudentUid) {
      void runSave(async () => {
        await updateAdminStudent(editingStudentUid, { name: studentForm.name, academic: academicInput(studentForm) });
        setEditingStudentUid('');
        setStudentForm({ ...emptyStudent, departmentId: data?.departments[0]?.id ?? '' });
      }, 'Student account and academic assignment updated.');
      return;
    }
    void runSave(async () => {
      await createAdminStudent({
        name: studentForm.name,
        email: studentForm.email,
        temporaryPassword: studentForm.temporaryPassword,
        academic: academicInput(studentForm),
      });
      setStudentForm({ ...emptyStudent, departmentId: data?.departments[0]?.id ?? '' });
    }, 'Student account created and assigned. Deliver the temporary password securely.');
  };

  const editStudent = (uid: string) => {
    const student = data?.students.find((entry) => entry.uid === uid);
    if (!student) return;
    setEditingStudentUid(uid);
    setStudentForm({
      name: student.name,
      email: student.email,
      studentId: student.studentId,
      departmentId: student.departmentId,
      btechYear: String(student.btechYear ?? 1),
      sectionId: student.sectionId,
      semester: String(student.semester ?? 1),
      enrollmentStatus: student.enrollmentStatus === 'inactive' ? 'inactive' : 'active',
      temporaryPassword: '',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const pages: Array<{ id: AdminPage; title: string }> = [
    { id: 'departments', title: 'Departments' },
    { id: 'classes', title: 'Classes & Years' },
    { id: 'subjects', title: 'Subjects' },
    { id: 'students', title: 'Students' },
    { id: 'reports', title: 'Academic reports' },
  ];

  return <div className="page-wrap module-page college-management">
    <section className="module-heading">
      <div>
        <div className="eyebrow"><ShieldCheck size={14} /> Administration</div>
        <h1>College Management</h1>
        <p className="hero-copy">Manage academic structure, student assignments, subject teaching, and college-wide performance from trusted admin access.</p>
      </div>
      <div className="college-summary"><Users size={17} /> {data?.students.length ?? 0} linked students</div>
    </section>
    {error && <div className="login-notice" role="alert">{error}<button className="text-button" type="button" onClick={() => { void loadData(); }}>Retry</button></div>}
    {notice && <div className="faculty-success" role="status"><CheckCircle2 size={16} />{notice}</div>}
    <nav className="college-tabs" aria-label="College management sections">
      {pages.map((item) => <button key={item.id} type="button" className={`filter ${page === item.id ? 'active' : ''}`} onClick={() => setPage(item.id)}>{item.title}</button>)}
    </nav>

    {loading && <div className="faculty-directory-state"><LoaderCircle className="spinning" size={18} /> Loading authorized college records…</div>}
    {!loading && data && page === 'departments' && <section className="panel college-panel">
      <div className="section-heading-row"><div><div className="eyebrow">Organization</div><h2>Departments</h2></div></div>
      <form className="faculty-admin-form" onSubmit={submitDepartment}>
        <label><span>Department name</span><input value={departmentName} onChange={(event) => setDepartmentName(event.target.value)} maxLength={120} required /></label>
        <label><span>Department code</span><input value={departmentCode} onChange={(event) => setDepartmentCode(event.target.value.toUpperCase())} maxLength={24} pattern="[A-Z0-9_-]+" required /></label>
        <div className="faculty-form-actions"><button className="primary-button" type="submit" disabled={saving}><Plus size={15} /> Add department</button></div>
      </form>
      <div className="college-record-list">{data.departments.map((department) => <article className="college-record" key={department.id}>
        <div><b>{department.name}</b><span>{department.code} · {department.id}</span></div>
        <span className={`faculty-status ${department.status}`}>{department.status}</span>
        <button className="secondary-button" type="button" disabled={saving} onClick={() => {
          const name = window.prompt('Department name', department.name);
          if (name?.trim()) void runSave(() => updateAdminDepartment(department.id, { name, status: department.status }), 'Department updated.');
        }}><Pencil size={14} /> Rename</button>
        <button className="secondary-button" type="button" disabled={saving} onClick={() => {
          const status = department.status === 'active' ? 'inactive' : 'active';
          void runSave(() => updateAdminDepartment(department.id, { name: department.name, status }), `Department ${status}.`);
        }}>{department.status === 'active' ? 'Deactivate' : 'Activate'}</button>
      </article>)}
      {!data.departments.length && <p className="muted">No departments are configured yet.</p>}</div>
    </section>}

    {!loading && data && page === 'classes' && <section className="panel college-panel">
      <div className="section-heading-row"><div><div className="eyebrow">Academic structure</div><h2>B.Tech years and class sections</h2></div></div>
      <form className="faculty-admin-form" onSubmit={submitClass}>
        <label><span>Department</span><select value={classForm.departmentId} disabled={Boolean(editingClassId)} onChange={(event) => setClassForm({ ...classForm, departmentId: event.target.value })} required>{data.departments.filter((department) => department.status === 'active').map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>
        <label><span>Year</span><select value={classForm.btechYear} disabled={Boolean(editingClassId)} onChange={(event) => setClassForm({ ...classForm, btechYear: event.target.value })}>{[1, 2, 3, 4].map((year) => <option key={year} value={year}>B.Tech Year {year}</option>)}</select></label>
        <label><span>Semester</span><select value={classForm.semester} disabled={Boolean(editingClassId)} onChange={(event) => setClassForm({ ...classForm, semester: event.target.value })}>{[1, 2, 3, 4, 5, 6, 7, 8].map((semester) => <option key={semester} value={semester}>Semester {semester}</option>)}</select></label>
        <label><span>Section label</span><input value={classForm.section} disabled={Boolean(editingClassId)} onChange={(event) => setClassForm({ ...classForm, section: event.target.value.toUpperCase() })} maxLength={32} required /></label>
        <label><span>Class code</span><input value={classForm.code} disabled={Boolean(editingClassId)} onChange={(event) => setClassForm({ ...classForm, code: event.target.value.toUpperCase() })} maxLength={80} required /></label>
        <label><span>Class name</span><input value={classForm.name} onChange={(event) => setClassForm({ ...classForm, name: event.target.value })} maxLength={120} required /></label>
        <label><span>Program</span><input value={classForm.course} disabled={Boolean(editingClassId)} onChange={(event) => setClassForm({ ...classForm, course: event.target.value })} maxLength={160} required /></label>
        <label><span>Initial faculty assignment (optional)</span><select value={classForm.facultyUid} onChange={(event) => setClassForm({ ...classForm, facultyUid: event.target.value })}><option value="">Unassigned</option>{activeFaculty.map((person) => <option key={person.uid} value={person.uid}>{person.name} · {person.employeeId}</option>)}</select></label>
        <div className="faculty-form-actions"><button className="primary-button" type="submit" disabled={saving || !data.departments.some((department) => department.status === 'active')}><Plus size={15} /> {editingClassId ? 'Save class' : 'Create class'}</button>{editingClassId && <button className="secondary-button" type="button" onClick={() => { setEditingClassId(''); setClassForm({ code: '', name: '', course: 'B.Tech', departmentId: data.departments[0]?.id ?? '', btechYear: '1', semester: '1', section: 'A', facultyUid: '' }); }}>Cancel</button>}</div>
      </form>
      <div className="college-record-list">{data.sections.map((section) => <article className="college-record" key={section.id}>
        <div><b>{section.code} · {section.name}</b><span>{section.course} · Year {section.btechYear ?? '—'}, Semester {section.semester ?? '—'} · {section.departmentId || 'No department'}</span></div>
        <span>{section.enrolledStudentUids.length} students</span>
        <span className={`faculty-status ${section.status}`}>{section.status}</span>
        <button className="secondary-button" type="button" disabled={saving} onClick={() => {
          setEditingClassId(section.id);
          setClassForm({
            code: section.code,
            name: section.name,
            course: section.course,
            departmentId: section.departmentId,
            btechYear: String(section.btechYear ?? 1),
            semester: String(section.semester ?? 1),
            section: section.name,
            facultyUid: section.assignedFacultyUid ?? '',
          });
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}><Pencil size={14} /> Edit</button>
        <button className="secondary-button" type="button" disabled={saving} onClick={() => void runSave(() => updateAdminClass(section.id, {
          name: section.name,
          facultyUid: section.assignedFacultyUid ?? '',
          status: section.status === 'active' ? 'inactive' : 'active',
        }), `Class ${section.status === 'active' ? 'deactivated' : 'activated'}.`)}>{section.status === 'active' ? 'Deactivate' : 'Activate'}</button>
      </article>)}</div>
    </section>}

    {!loading && data && page === 'subjects' && <section className="panel college-panel">
      <div className="section-heading-row"><div><div className="eyebrow">Teaching allocation</div><h2>Subjects and faculty assignments</h2></div></div>
      <form className="faculty-admin-form" onSubmit={submitSubject}>
        <label><span>Department</span><select value={subjectForm.departmentId} onChange={(event) => setSubjectForm({ ...subjectForm, departmentId: event.target.value, sectionIds: [] })} required>{data.departments.filter((department) => department.status === 'active').map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>
        <label><span>Subject code</span><input value={subjectForm.code} onChange={(event) => setSubjectForm({ ...subjectForm, code: event.target.value.toUpperCase() })} maxLength={24} required /></label>
        <label><span>Subject name</span><input value={subjectForm.name} onChange={(event) => setSubjectForm({ ...subjectForm, name: event.target.value })} maxLength={120} required /></label>
        <label><span>Assigned faculty</span><select value={subjectForm.facultyUid} onChange={(event) => setSubjectForm({ ...subjectForm, facultyUid: event.target.value })} required><option value="">Select faculty</option>{activeFaculty.map((person) => <option key={person.uid} value={person.uid}>{person.name}</option>)}</select></label>
        <div className="college-section-checks"><span>Classes</span>{data.sections.filter((section) => section.departmentId === subjectForm.departmentId).map((section) => <label key={section.id}><input type="checkbox" checked={subjectForm.sectionIds.includes(section.id)} onChange={(event) => setSubjectForm((current) => ({ ...current, sectionIds: event.target.checked ? [...current.sectionIds, section.id] : current.sectionIds.filter((id) => id !== section.id) }))} /> {section.code} · {section.name}</label>)}</div>
        <div className="faculty-form-actions"><button className="primary-button" type="submit" disabled={saving || !subjectForm.sectionIds.length}><Plus size={15} /> Create and assign subject</button></div>
      </form>
      <div className="college-record-list">{data.subjects.map((subject) => <article className="college-record" key={subject.id}>
        <div><b>{subject.code} · {subject.name}</b><span>{subject.departmentId} · {subject.sectionIds.length} assigned classes</span></div>
        <span>{faculty.find((person) => person.uid === subject.facultyUid)?.name ?? 'Faculty unavailable'}</span>
      </article>)}</div>
    </section>}

    {!loading && data && page === 'students' && <section className="panel college-panel">
      <div className="section-heading-row"><div><div className="eyebrow">Verified academic profiles</div><h2>{editingStudentUid ? 'Edit student assignment' : 'Create student account'}</h2></div>{editingStudentUid && <button className="secondary-button" type="button" onClick={() => { setEditingStudentUid(''); setStudentForm(emptyStudent); }}>Cancel edit</button>}</div>
      <form className="faculty-admin-form" onSubmit={submitStudent}>
        <label><span>Full name</span><input value={studentForm.name} onChange={(event) => setStudentForm({ ...studentForm, name: event.target.value })} maxLength={120} required /></label>
        {!editingStudentUid && <label><span>Email</span><input type="email" value={studentForm.email} onChange={(event) => setStudentForm({ ...studentForm, email: event.target.value })} maxLength={320} required /></label>}
        <label><span>Student ID</span><input value={studentForm.studentId} onChange={(event) => setStudentForm({ ...studentForm, studentId: event.target.value })} maxLength={64} required /></label>
        <label><span>Department</span><select value={studentForm.departmentId} onChange={(event) => setStudentForm({ ...studentForm, departmentId: event.target.value, sectionId: '' })} required>{data.departments.filter((department) => department.status === 'active').map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>
        <label><span>B.Tech year</span><select value={studentForm.btechYear} onChange={(event) => setStudentForm({ ...studentForm, btechYear: event.target.value, sectionId: '' })}>{[1, 2, 3, 4].map((year) => <option key={year} value={year}>{year}</option>)}</select></label>
        <label><span>Semester</span><select value={studentForm.semester} onChange={(event) => setStudentForm({ ...studentForm, semester: event.target.value, sectionId: '' })}>{[1, 2, 3, 4, 5, 6, 7, 8].map((semester) => <option key={semester} value={semester}>{semester}</option>)}</select></label>
        <label><span>Class section</span><select value={studentForm.sectionId} onChange={(event) => setStudentForm({ ...studentForm, sectionId: event.target.value })} required><option value="">Select class</option>{availableSections.map((section) => <option key={section.id} value={section.id}>{section.code} · {section.name}</option>)}</select></label>
        <label><span>Enrollment status</span><select value={studentForm.enrollmentStatus} onChange={(event) => setStudentForm({ ...studentForm, enrollmentStatus: event.target.value as StudentForm['enrollmentStatus'] })}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
        {!editingStudentUid && <label><span>Temporary password (12+ characters)</span><input type="password" value={studentForm.temporaryPassword} onChange={(event) => setStudentForm({ ...studentForm, temporaryPassword: event.target.value })} minLength={12} maxLength={128} required autoComplete="new-password" /></label>}
        <div className="faculty-form-actions"><button className="primary-button" type="submit" disabled={saving || !studentForm.sectionId}>{saving ? <LoaderCircle className="spinning" size={15} /> : <CheckCircle2 size={15} />}{editingStudentUid ? 'Save student assignment' : 'Create student'}</button></div>
        {!editingStudentUid && <p className="muted faculty-password-note">The password is used only for Firebase Authentication and must be delivered to the student securely. Academic assignment is admin-controlled.</p>}
      </form>
      <div className="college-record-list">{data.students.map((student) => <article className="college-record" key={student.uid}>
        <div><b>{student.name} · {student.studentId || 'ID missing'}</b><span>{student.email} · {student.departmentId || 'No department'} · B.Tech {student.btechYear ?? '—'}, semester {student.semester ?? '—'} · {student.sectionId || 'Unassigned'}</span></div>
        <span className={`faculty-status ${student.enrollmentStatus}`}>{student.enrollmentStatus}</span>
        <button className="secondary-button" type="button" onClick={() => editStudent(student.uid)}><Pencil size={14} /> Edit</button>
      </article>)}
      {!data.students.length && <p className="muted">No student accounts are provisioned.</p>}</div>
    </section>}

    {!loading && reports && page === 'reports' && <section className="college-reports">
      <div className="metrics-grid">
        <div className="metric-card"><div className="metric-top"><span>Departments</span><ShieldCheck size={15} /></div><strong>{reports.totals.departments}</strong><small>Configured academic departments</small></div>
        <div className="metric-card"><div className="metric-top"><span>Faculty</span><Users size={15} /></div><strong>{reports.totals.faculty}</strong><small>Trusted faculty roles</small></div>
        <div className="metric-card"><div className="metric-top"><span>Students</span><Users size={15} /></div><strong>{reports.totals.students}</strong><small>Provisioned student profiles</small></div>
        <div className="metric-card"><div className="metric-top"><span>Classes</span><Activity size={15} /></div><strong>{reports.totals.sections}</strong><small>Existing course sections</small></div>
      </div>
      <div className="college-record-list">{reports.sections.map((section) => <article className="college-record" key={section.sectionId}>
        <div><b>{section.code || section.sectionId} · {section.course}</b><span>{section.departmentId || 'Department not assigned'} · B.Tech {section.btechYear ?? '—'} · Semester {section.semester ?? '—'}</span></div>
        <span>{section.studentCount} students</span>
        <span>{section.averagePercentage === null ? 'No marks' : `${section.averagePercentage.toFixed(1)}% average`} · {section.studentsWithMarks} with marks</span>
        <span>{section.attendanceAverage === null ? 'No attendance' : `${section.attendanceAverage.toFixed(1)}% attendance`}</span>
      </article>)}
      {!reports.sections.length && <div className="panel module-empty"><h2>No academic records</h2><p>College reports will appear when real class, attendance, and marks data is available.</p></div>}</div>
    </section>}
  </div>;
}
