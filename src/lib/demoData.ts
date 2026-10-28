import type { CourseMaterial, CourseSection, StudentRecord } from './types';

const names = [
  'Aarav Sharma', 'Aditi Rao', 'Ananya Iyer', 'Arjun Mehta', 'Diya Nair', 'Ishaan Verma',
  'Kabir Singh', 'Kiara Shah', 'Meera Joshi', 'Neel Patel', 'Nisha Kapoor', 'Om Prakash',
  'Pari Desai', 'Rahul Das', 'Riya Menon', 'Saanvi Kulkarni', 'Sameer Khan', 'Tara Bose',
  'Uday Reddy', 'Vanya Gupta', 'Vihaan Roy', 'Yash Malhotra', 'Zara Ali', 'Advik Sen',
  'Ira Choudhury', 'Mohan Kumar'
];
const math = [88,76,93,64,81,58,72,95,67,84,49,78,90,61,74,86,53,70,82,97,65,75,88,57,79,69];
const science = [91,82,95,71,78,63,69,89,74,87,56,73,92,55,80,83,48,76,79,94,68,71,85,64,88,60];
const english = [84,79,91,68,86,61,75,94,70,80,52,81,88,66,77,89,59,72,85,96,62,78,90,55,74,67];
const attendance = [96,88,98,82,91,74,79,99,86,93,68,77,97,72,84,95,69,81,90,100,76,87,92,73,89,78];

const students: StudentRecord[] = names.map((name, index) => ({
  id: `student-${index + 1}`,
  name,
  rollNo: `b24in${String(index + 1).padStart(3, '0')}`,
  attendance: attendance[index],
  marks: { Mathematics: math[index], Science: science[index], English: english[index] },
}));

const materials: CourseMaterial[] = [
  { id: 'm1', name: 'Unit 1 · Algebra foundations', type: 'PDF', subject: 'Mathematics', tags: ['algebra', 'equations', 'foundations'], source: 'Demo library' },
  { id: 'm2', name: 'Problem set · Differential equations', type: 'Worksheet', subject: 'Mathematics', tags: ['practice', 'calculus'], source: 'Demo library' },
  { id: 'm3', name: 'Lab manual · Motion and force', type: 'PDF', subject: 'Science', tags: ['lab', 'mechanics'], source: 'Demo library' },
  { id: 'm4', name: 'Revision notes · Matter and energy', type: 'Notes', subject: 'Science', tags: ['revision', 'matter'], source: 'Demo library' },
  { id: 'm5', name: 'Writing clinic · Academic paragraphs', type: 'Guide', subject: 'English', tags: ['writing', 'grammar'], source: 'Demo library' },
  { id: 'm6', name: 'Previous paper · Midterm practice', type: 'Question paper', subject: 'All subjects', tags: ['assessment', 'practice'], source: 'Demo library' },
];

export const demoSections: CourseSection[] = [
  {
    id: 'cse-a', code: 'B24-IN-A', name: 'Section A', course: 'B.Tech Information Science', term: 'Semester 3 · 2026',
    faculty: 'Dr. Kavya Menon', facultyEmail: 'kavya.menon@learnpulse.edu', room: 'Block C · 204', schedule: 'Mon / Wed · 10:00 AM',
    subjects: ['Mathematics', 'Science', 'English'], students, materials,
  },
  {
    id: 'cse-b', code: 'B24-IN-B', name: 'Section B', course: 'B.Tech Information Science', term: 'Semester 3 · 2026',
    faculty: 'Prof. Rohan Das', facultyEmail: 'rohan.das@learnpulse.edu', room: 'Block C · 206', schedule: 'Tue / Thu · 11:30 AM',
    subjects: ['Mathematics', 'Science', 'English'],
    students: students.slice(0, 18).map((student, index) => ({ ...student, id: `b-${student.id}`, marks: { Mathematics: Math.max(42, student.marks.Mathematics - (index % 3) * 3), Science: Math.max(44, student.marks.Science - 2), English: Math.max(48, student.marks.English + 1) } })),
    materials: materials.map((material) => ({ ...material, id: `b-${material.id}` })),
  },
];
