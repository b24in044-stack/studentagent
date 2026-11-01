import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, LoaderCircle, Plus, RefreshCw } from 'lucide-react';
import {
  createSectionAssessment,
  fetchSectionAssessments,
  saveSectionAssessmentMark,
  type SectionAssessment,
  type SectionAssessmentMark,
} from '../lib/firebaseData';
import type { StudentRecord } from '../lib/types';

type Props = {
  sectionId: string;
  subjects: string[];
  students?: StudentRecord[];
  studentUid?: string;
  mode: 'faculty' | 'student';
};

const assessmentTypes = [
  ['internal', 'Internal examination'],
  ['assignment', 'Assignment'],
  ['class-test', 'Class test'],
  ['quiz', 'Quiz'],
  ['practical', 'Practical examination'],
  ['mid-exam', 'Mid examination'],
  ['final-exam', 'Final examination'],
  ['other', 'Other'],
];

export default function AssessmentPanel({ sectionId, subjects, students = [], studentUid, mode }: Props) {
  const [assessments, setAssessments] = useState<SectionAssessment[]>([]);
  const [marks, setMarks] = useState<SectionAssessmentMark[]>([]);
  const [weightedPercentage, setWeightedPercentage] = useState<number | null>(null);
  const [selectedAssessmentId, setSelectedAssessmentId] = useState('');
  const [scores, setScores] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ name: '', type: 'internal', maxMarks: '100', date: new Date().toISOString().slice(0, 10), subjectId: '', weightage: '0', required: false });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await fetchSectionAssessments(sectionId);
      setAssessments(result.assessments);
      setMarks(result.marks);
      setWeightedPercentage(result.weightedPercentage ?? null);
      setSelectedAssessmentId((current) => result.assessments.some((assessment) => assessment.id === current)
        ? current
        : result.assessments[0]?.id ?? '');
      setScores(Object.fromEntries(result.marks.map((mark) => [`${mark.assessmentId}:${mark.studentUid}`, String(mark.obtainedMarks)])));
      setForm((current) => ({ ...current, subjectId: current.subjectId || subjects[0] || '' }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Assessment records could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [sectionId, mode, studentUid]);

  const activeAssessment = assessments.find((assessment) => assessment.id === selectedAssessmentId);
  const myMarks = useMemo(() => new Map(marks.map((mark) => [mark.assessmentId, mark])), [marks]);
  const missingRequired = assessments.filter((assessment) =>
    assessment.required && (!studentUid || !myMarks.has(assessment.id)));

  const createAssessment = (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    void createSectionAssessment(sectionId, {
      name: form.name,
      type: form.type,
      maxMarks: Number(form.maxMarks),
      date: form.date,
      subjectId: form.subjectId,
      weightage: Number(form.weightage),
      required: form.required,
    }).then(async () => {
      setForm((current) => ({ ...current, name: '' }));
      setNotice('Assessment created.');
      await load();
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Assessment could not be created.');
    }).finally(() => setSaving(false));
  };

  const saveMark = async (student: StudentRecord, assessment: SectionAssessment) => {
    const key = `${assessment.id}:${student.id}`;
    const value = Number(scores[key]);
    if (!scores[key]?.trim() || !Number.isFinite(value) || value < 0 || value > assessment.maxMarks) {
      setError(`Enter a mark from 0 to ${assessment.maxMarks} for ${student.name}.`);
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await saveSectionAssessmentMark(sectionId, assessment.id, student.id, value);
      setNotice(`Marks saved for ${student.name}.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Marks could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return <section className="panel assessment-panel">
    <div className="section-heading-row">
      <div><div className="eyebrow">{mode === 'faculty' ? 'Assessment configuration' : 'Assessment results'}</div><h2>{mode === 'faculty' ? 'Assessments & marks' : 'My assessment marks'}</h2></div>
      <button className="secondary-button" type="button" onClick={() => { void load(); }} disabled={loading}><RefreshCw size={14} /> Refresh</button>
    </div>
    {error && <div className="login-notice" role="alert"><AlertTriangle size={15} />{error}</div>}
    {notice && <div className="faculty-success" role="status"><CheckCircle2 size={15} />{notice}</div>}
    {loading ? <div className="faculty-directory-state"><LoaderCircle size={17} className="spinning" /> Loading assessment data…</div>
      : mode === 'faculty' ? <>
        <form className="faculty-admin-form assessment-create-form" onSubmit={createAssessment}>
          <label><span>Assessment name</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} maxLength={120} required /></label>
          <label><span>Type</span><select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>{assessmentTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label><span>Subject</span><select value={form.subjectId} onChange={(event) => setForm({ ...form, subjectId: event.target.value })} required>{subjects.map((subject) => <option key={subject} value={subject}>{subject}</option>)}</select></label>
          <label><span>Maximum marks</span><input type="number" min="0.01" max="10000" step="any" value={form.maxMarks} onChange={(event) => setForm({ ...form, maxMarks: event.target.value })} required /></label>
          <label><span>Assessment date</span><input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} required /></label>
          <label><span>Weightage (%)</span><input type="number" min="0" max="100" step="any" value={form.weightage} onChange={(event) => setForm({ ...form, weightage: event.target.value })} required /></label>
          <label className="assessment-required"><input type="checkbox" checked={form.required} onChange={(event) => setForm({ ...form, required: event.target.checked })} /> Required for weighted grade</label>
          <div className="faculty-form-actions"><button className="primary-button" type="submit" disabled={saving || !subjects.length}><Plus size={15} /> Create assessment</button></div>
        </form>
        {!subjects.length && <p className="muted">Add a subject to this section before configuring assessments.</p>}
        {!assessments.length ? <div className="empty-state">No assessments are configured for this section.</div> : <>
          <label className="select-wrap assessment-select"><span>Assessment</span><select value={selectedAssessmentId} onChange={(event) => setSelectedAssessmentId(event.target.value)}>{assessments.map((assessment) => <option key={assessment.id} value={assessment.id}>{assessment.name} · {assessment.subjectName ?? assessment.subjectId} · max {assessment.maxMarks}</option>)}</select></label>
          {activeAssessment && <div className="table-shell"><table className="student-table"><thead><tr><th>Student</th><th>Assessment</th><th>Maximum</th><th>Obtained</th><th /></tr></thead><tbody>
            {students.map((student) => {
              const key = `${activeAssessment.id}:${student.id}`;
              return <tr key={student.id}><td>{student.name} · {student.rollNo}</td><td>{activeAssessment.name}</td><td>{activeAssessment.maxMarks}</td><td><input className="assessment-mark-input" aria-label={`${activeAssessment.name} marks for ${student.name}`} type="number" min="0" max={activeAssessment.maxMarks} step="any" value={scores[key] ?? ''} onChange={(event) => setScores({ ...scores, [key]: event.target.value })} /></td><td><button className="text-button" type="button" disabled={saving} onClick={() => { void saveMark(student, activeAssessment); }}>Save / correct</button></td></tr>;
            })}
            {!students.length && <tr><td colSpan={5}>No enrolled students are available for this section.</td></tr>}
          </tbody></table></div>}
        </>}
      </> : <>
        <div className="assessment-student-summary">
          <div className="metric-card"><div className="metric-top"><span>Weighted overall</span></div><strong>{weightedPercentage === null ? '—' : `${weightedPercentage.toFixed(1)}%`}</strong><small>{weightedPercentage === null ? 'Required configured assessments are missing or weights do not total 100%.' : 'Calculated from recorded required marks.'}</small></div>
          <div className="metric-card"><div className="metric-top"><span>Missing required</span></div><strong>{missingRequired.length}</strong><small>Required assessments without a recorded mark.</small></div>
        </div>
        {!assessments.length ? <div className="empty-state">No assessment records are available for this enrolled class.</div> : <div className="table-shell"><table className="student-table"><thead><tr><th>Assessment</th><th>Subject</th><th>Type</th><th>Date</th><th>Marks</th><th>Weightage</th></tr></thead><tbody>{assessments.map((assessment) => {
          const mark = myMarks.get(assessment.id);
          return <tr key={assessment.id}><td>{assessment.name}{assessment.required && <span className="cell-sub">Required</span>}</td><td>{assessment.subjectName ?? assessment.subjectId}</td><td>{assessment.type}</td><td>{assessment.date.slice(0, 10)}</td><td>{mark ? `${mark.obtainedMarks} / ${assessment.maxMarks}` : 'Missing'}</td><td>{assessment.weightage}%</td></tr>;
        })}</tbody></table></div>}
      </>}
  </section>;
}
