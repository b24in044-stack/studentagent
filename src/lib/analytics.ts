import type { CourseSection, StudentInsight, StudentRecord } from './types';

export const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

export function studentAverage(student: StudentRecord, subjects: string[]) {
  const scores = subjects.map((subject) => student.marks[subject]).filter((value) => Number.isFinite(value));
  return average(scores);
}

export function classAverage(section: CourseSection) {
  return average(section.students.map((student) => studentAverage(student, section.subjects)));
}

export function subjectAverage(section: CourseSection, subject: string) {
  return average(section.students.map((student) => student.marks[subject]).filter((value) => Number.isFinite(value)));
}

export function insightFor(section: CourseSection, student: StudentRecord): StudentInsight {
  const overall = studentAverage(student, section.subjects);
  const sectionAverage = classAverage(section);
  const ranked = section.subjects
    .filter((subject) => Number.isFinite(student.marks[subject]))
    .map((subject) => ({ subject, score: student.marks[subject], average: subjectAverage(section, subject) }));
  const best = [...ranked].sort((a, b) => b.score - a.score)[0];
  const weak = [...ranked].sort((a, b) => a.score - b.score)[0];
  const bestSubject = best?.subject ?? 'Not available';
  const weakSubject = weak?.subject ?? 'Not available';
  const bestScore = best?.score ?? 0;
  const weakScore = weak?.score ?? 0;
  const gap = overall - sectionAverage;
  const group = gap >= 5 ? 'Best performance' : gap <= -5 ? 'Needs focused improvement' : 'Needs a little improvement';
  const level = overall >= 85 ? 'Excellent' : overall >= 70 ? 'Good' : overall >= 50 ? 'Needs Improvement' : 'At Risk';
  const strengths = best
    ? [best.score >= best.average ? `Strong in ${best.subject} (${best.score.toFixed(1)}%), above the section subject average.` : `Most confident area: ${best.subject} (${best.score.toFixed(1)}%).`]
    : ['Upload marks for this student to calculate strengths.'];
  const weaknesses = weak
    ? [weak.score < weak.average ? `Needs improvement in ${weak.subject} (${weak.score.toFixed(1)}%), below the section subject average.` : `Keep building consistency in ${weak.subject} (${weak.score.toFixed(1)}%).`]
    : ['No subject marks are available yet.'];
  return {
    overall, classAverage: sectionAverage, gap, group, level, bestSubject, bestScore, weakSubject, weakScore, strengths, weaknesses,
    recommendation: weak ? `Focus the next study block on ${weak.subject}: review the assigned material, complete two practice sets, and ask faculty for feedback.` : 'Ask faculty to upload the section marks before building a subject study plan.',
    attendanceAlert: student.attendance !== undefined && student.attendance < 75 ? `Attendance is ${student.attendance}%, below the 75% monitoring threshold.` : undefined,
  };
}

export function sectionStats(section: CourseSection) {
  const values = section.students.map((student) => studentAverage(student, section.subjects));
  const classAvg = average(values);
  return {
    average: classAvg,
    highest: values.length ? Math.max(...values) : 0,
    lowest: values.length ? Math.min(...values) : 0,
    above: values.filter((value) => value > classAvg).length,
    below: values.filter((value) => value < classAvg).length,
  };
}
