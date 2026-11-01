import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CheckCircle2, LoaderCircle, Pencil, Plus, Search, ShieldCheck, UserRound, X } from 'lucide-react';
import {
  createAdminFaculty,
  fetchAdminFaculty,
  setAdminFacultySections,
  setAdminFacultyStatus,
  updateAdminFaculty,
  type AdminFaculty,
  type AdminFacultyInput,
  type AdminSectionOption,
} from '../lib/firebaseData';

const emptyForm: AdminFacultyInput = { name: '', email: '', employeeId: '', department: '' };

export default function FacultyManagement() {
  const [faculty, setFaculty] = useState<AdminFaculty[]>([]);
  const [sections, setSections] = useState<AdminSectionOption[]>([]);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<AdminFaculty | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const [sectionIds, setSectionIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await fetchAdminFaculty();
      setFaculty(result.faculty);
      setSections(result.sections);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Faculty records could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadData(); }, []);

  const filteredFaculty = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return faculty.filter((person) => !needle || [
      person.name, person.email, person.employeeId, person.department,
    ].some((value) => value.toLowerCase().includes(needle)));
  }, [faculty, query]);

  const beginCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setTemporaryPassword('');
    setSectionIds([]);
    setSuccess('');
    setError('');
  };

  const beginEdit = (person: AdminFaculty) => {
    setEditing(person);
    setForm({
      name: person.name,
      email: person.email,
      employeeId: person.employeeId,
      department: person.department,
    });
    setTemporaryPassword('');
    setSectionIds(person.assignedSections.map((section) => section.id));
    setSuccess('');
    setError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setSuccess('');
    setSaving(true);
    try {
      if (editing) {
        await updateAdminFaculty(editing.uid, form);
        setSuccess('Faculty profile updated.');
      } else {
        await createAdminFaculty(form, temporaryPassword);
        setSuccess('Faculty account created and activated. Share the temporary password with the faculty member through a secure channel.');
        setTemporaryPassword('');
        setForm(emptyForm);
      }
      await loadData();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Faculty account could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const handleStatus = async (person: AdminFaculty) => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const nextStatus = person.status === 'active' ? 'inactive' : 'active';
      await setAdminFacultyStatus(person.uid, nextStatus);
      setSuccess(`${person.name} is now ${nextStatus}.`);
      await loadData();
      if (editing?.uid === person.uid) setEditing((current) => current ? { ...current, status: nextStatus } : null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Faculty access status could not be changed.');
    } finally {
      setSaving(false);
    }
  };

  const handleAssignments = async () => {
    if (!editing) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await setAdminFacultySections(editing.uid, sectionIds);
      setSuccess('Faculty course assignments updated.');
      await loadData();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Course assignments could not be updated.');
    } finally {
      setSaving(false);
    }
  };

  return <div className="page-wrap module-page faculty-management">
    <section className="module-heading">
      <div>
        <div className="eyebrow"><ShieldCheck size={14} /> Administration</div>
        <h1>Faculty Management</h1>
        <p className="hero-copy">Create faculty accounts, maintain their trusted profiles, control access, and assign course sections.</p>
      </div>
      <button className="primary-button" type="button" onClick={beginCreate}><Plus size={16} /> New faculty account</button>
    </section>

    {error && <div className="login-notice" role="alert">{error}<button className="text-button" type="button" onClick={() => { void loadData(); }}>Retry</button></div>}
    {success && <div className="faculty-success" role="status"><CheckCircle2 size={16} />{success}</div>}

    <section className="panel faculty-form-panel">
      <div className="section-heading-row">
        <div><div className="eyebrow">{editing ? 'Edit trusted profile' : 'Secure provisioning'}</div><h2>{editing ? `Edit ${editing.name}` : 'Create faculty account'}</h2></div>
        {editing && <button className="secondary-button" type="button" onClick={beginCreate}><X size={15} /> Close edit</button>}
      </div>
      <form className="faculty-admin-form" onSubmit={(event) => { void handleSubmit(event); }}>
        <label><span>Full name</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} maxLength={120} required autoComplete="name" /></label>
        <label><span>Email</span><input value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} type="email" maxLength={320} required autoComplete="email" /></label>
        <label><span>Employee ID</span><input value={form.employeeId} onChange={(event) => setForm({ ...form, employeeId: event.target.value })} maxLength={64} required /></label>
        <label><span>Department</span><input value={form.department} onChange={(event) => setForm({ ...form, department: event.target.value })} maxLength={120} required /></label>
        {!editing && <label className="faculty-password-field"><span>Temporary password (12+ characters)</span><input value={temporaryPassword} onChange={(event) => setTemporaryPassword(event.target.value)} type="password" minLength={12} maxLength={128} required autoComplete="new-password" /></label>}
        <div className="faculty-form-actions">
          <button className="primary-button" type="submit" disabled={saving}>{saving ? <LoaderCircle size={15} className="spinning" /> : <CheckCircle2 size={15} />}{editing ? 'Save profile' : 'Create account'}</button>
        </div>
        {!editing && <p className="muted faculty-password-note">The password is sent only to Firebase Authentication for account creation. LearnPulse does not save or return it. Deliver it to the faculty member through a secure channel.</p>}
      </form>
    </section>

    {editing && <section className="panel faculty-assignment-panel">
      <div className="section-heading-row"><div><div className="eyebrow">Course access</div><h2>Assign course sections</h2></div><button className="primary-button" type="button" onClick={() => { void handleAssignments(); }} disabled={saving || editing.status !== 'active'}>Save assignments</button></div>
      {editing.status !== 'active' && <p className="muted">Activate this account before changing its course assignments.</p>}
      {sections.length ? <div className="faculty-section-options">{sections.map((section) => <label key={section.id} className="faculty-section-option">
        <input type="checkbox" checked={sectionIds.includes(section.id)} disabled={saving || editing.status !== 'active'} onChange={(event) => setSectionIds((current) => event.target.checked ? [...current, section.id] : current.filter((id) => id !== section.id))} />
        <span><b>{section.code} · {section.course}</b><small>{section.name}{section.assignedFacultyUid && section.assignedFacultyUid !== editing.uid ? ' · currently assigned elsewhere' : ''}</small></span>
      </label>)}</div> : <p className="muted">No course sections exist yet. Course sections must first be created through the existing faculty course-management flow.</p>}
    </section>}

    <section className="faculty-directory">
      <div className="section-heading-row"><div><div className="eyebrow">Trusted accounts</div><h2>Faculty directory <span className="muted">({faculty.length})</span></h2></div>
        <label className="search-box faculty-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search faculty" aria-label="Search faculty" /></label>
      </div>
      {loading ? <div className="panel faculty-directory-state" role="status"><LoaderCircle size={18} className="spinning" /> Loading faculty accounts…</div>
        : !filteredFaculty.length ? <div className="panel faculty-directory-state">{faculty.length ? 'No faculty match your search.' : 'No faculty accounts have been provisioned yet.'}</div>
          : <div className="faculty-directory-grid">{filteredFaculty.map((person) => <article className="panel faculty-directory-card" key={person.uid}>
            <div className="faculty-directory-title"><div className="avatar"><UserRound size={17} /></div><div><h3>{person.name}</h3><span>{person.department || 'Department not set'}</span></div><span className={`faculty-status ${person.status}`}>{person.status}</span></div>
            <dl><div><dt>Email</dt><dd>{person.email}</dd></div><div><dt>Employee ID</dt><dd>{person.employeeId || 'Not set'}</dd></div><div><dt>Assigned sections</dt><dd>{person.assignedSections.length ? person.assignedSections.map((section) => section.code).join(', ') : 'None'}</dd></div></dl>
            <div className="faculty-directory-actions"><button className="secondary-button" type="button" onClick={() => beginEdit(person)}><Pencil size={14} /> Edit & assign</button><button className="text-button" type="button" disabled={saving} onClick={() => { void handleStatus(person); }}>{person.status === 'active' ? 'Deactivate' : 'Activate'}</button></div>
          </article>)}</div>}
    </section>
  </div>;
}
