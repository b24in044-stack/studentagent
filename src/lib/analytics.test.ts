import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classAverage, insightFor, sectionStats } from './analytics';
import type { CourseSection } from './types';

const section: CourseSection = {
  id: 'section-1',
  code: 'BIO-101',
  name: 'Biology',
  course: 'Biology',
  term: 'Fall',
  faculty: 'Faculty',
  facultyEmail: '',
  room: '',
  schedule: '',
  subjects: ['Biology'],
  students: [
    { id: 'student-1', name: 'Student One', rollNo: '1', marks: {} },
    { id: 'student-2', name: 'Student Two', rollNo: '2', marks: { Biology: 80 } },
  ],
  materials: [],
};

describe('Learning analytics', () => {
  it('does not turn a missing mark into a performance signal', () => {
    const insight = insightFor(section, section.students[0]);
    assert.equal(insight.group, 'No marks');
    assert.equal(insight.level, 'No data');
    assert.deepEqual(insight.strengths, []);
    assert.deepEqual(insight.weaknesses, []);
  });

  it('calculates section averages from recorded marks only', () => {
    assert.equal(classAverage(section), 80);
    assert.deepEqual(sectionStats(section), { average: 80, highest: 80, lowest: 80, above: 0, below: 0 });
  });

  it('uses non-identifying cohort aggregates returned by the backend', () => {
    const withAggregate = {
      ...section,
      cohortSummary: { studentCount: 20, overallAverage: 72.5, subjectAverages: { Biology: 74 } },
    };
    assert.equal(classAverage(withAggregate), 72.5);
  });
});
