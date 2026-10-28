import { classAverage, insightFor, studentAverage, subjectAverage } from './analytics';
import type { CourseSection, LearningContext, StudentRecord } from './types';

export function recommendMaterials(section: CourseSection, student: StudentRecord) {
  const insight = insightFor(section, student);
  const focus = new Set([insight.weakSubject.toLowerCase()]);
  const ranked = section.materials
    .map((material) => {
      const searchable = `${material.subject} ${material.tags.join(' ')} ${material.name} ${material.excerpt ?? ''}`.toLowerCase();
      const direct = focus.has(material.subject.toLowerCase()) || material.subject.toLowerCase() === 'all subjects';
      const topicMatch = [...focus].some((topic) => searchable.includes(topic));
      return { material, score: (direct ? 4 : 0) + (topicMatch ? 2 : 0) + (material.source === 'Faculty upload' ? 1 : 0) };
    })
    .sort((a, b) => b.score - a.score || a.material.name.localeCompare(b.material.name));
  const matches = ranked.filter(({ score }) => score > 0).slice(0, 4);
  const fallback = matches.length ? matches : ranked.slice(0, 3);
  return fallback.map(({ material }) => ({
    material,
    reason: material.subject.toLowerCase() === insight.weakSubject.toLowerCase()
      ? `Matched to ${insight.weakSubject}, the learner's lowest-mark subject.`
      : material.subject.toLowerCase() === 'all subjects'
        ? 'General practice resource from this section library.'
        : 'Relevant section resource selected from its title, topic tags, and course notes.',
  }));
}

export function buildLearningContext(section: CourseSection, student: StudentRecord): LearningContext {
  const insight = insightFor(section, student);
  const materials = recommendMaterials(section, student).map(({ material }) => ({
    id: material.id, name: material.name, type: material.type, subject: material.subject, tags: material.tags, excerpt: material.excerpt?.slice(0, 6000),
  }));
  return {
    course: {
      title: section.course, sectionCode: section.code, sectionName: section.name, term: section.term,
      facultyName: section.faculty, facultyEmail: section.facultyEmail, room: section.room, schedule: section.schedule,
    },
    cohort: {
      studentCount: section.students.length,
      overallAverage: Number(classAverage(section).toFixed(2)),
      subjectAverages: Object.fromEntries(section.subjects.map((subject) => [subject, Number(subjectAverage(section, subject).toFixed(2))])),
    },
    learner: {
      subjectMarks: Object.fromEntries(section.subjects.filter((subject) => Number.isFinite(student.marks[subject])).map((subject) => [subject, student.marks[subject]])),
      overallAverage: Number(studentAverage(student, section.subjects).toFixed(2)),
      classGap: Number(insight.gap.toFixed(2)), attendance: student.attendance,
      strongestSubject: insight.bestSubject,
      focusSubjects: section.subjects.filter((subject) => Number.isFinite(student.marks[subject])).sort((a, b) => student.marks[a] - student.marks[b]).slice(0, 3),
    },
    retrievedMaterials: materials,
  };
}
