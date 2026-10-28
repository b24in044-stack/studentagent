import type { CourseSection } from './types';
import { supabaseClient } from './supabase';

type SectionRow = {
  id: string;
  code: string;
  name: string;
  course: string;
  term: string;
  faculty: string;
  faculty_email: string;
  room: string;
  schedule: string;
  section_subjects: { subject: string; position: number }[] | null;
  section_enrollments: {
    attendance: number | null;
    students: { id: string; name: string; roll_no: string } | null;
    student_marks: { subject: string; score: number }[] | null;
  }[] | null;
  course_materials: {
    id: string;
    name: string;
    type: string;
    subject: string;
    tags: string[] | null;
    source: 'Faculty upload' | 'Demo library';
    excerpt: string | null;
  }[] | null;
};

function getClient() {
  if (!supabaseClient) throw new Error('Supabase is not configured. Set the public Supabase URL and key in .env.');
  return supabaseClient;
}

export async function fetchCourseSections(): Promise<CourseSection[]> {
  const { data, error } = await getClient()
    .from('course_sections')
    .select('id,code,name,course,term,faculty,faculty_email,room,schedule,section_subjects(subject,position),section_enrollments(attendance,students!inner(id,name,roll_no),student_marks(subject,score)),course_materials(id,name,type,subject,tags,source,excerpt)')
    .order('code');

  if (error) throw new Error(`Could not load course data from Supabase: ${error.message}`);

  return ((data ?? []) as unknown as SectionRow[]).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    course: row.course,
    term: row.term,
    faculty: row.faculty,
    facultyEmail: row.faculty_email,
    room: row.room,
    schedule: row.schedule,
    subjects: [...(row.section_subjects ?? [])]
      .sort((left, right) => left.position - right.position)
      .map((item) => item.subject),
    students: (row.section_enrollments ?? []).flatMap((enrollment) => {
      if (!enrollment.students) return [];
      return [{
        id: enrollment.students.id,
        name: enrollment.students.name,
        rollNo: enrollment.students.roll_no,
        attendance: enrollment.attendance ?? undefined,
        marks: Object.fromEntries((enrollment.student_marks ?? []).map((mark) => [mark.subject, Number(mark.score)])),
      }];
    }),
    materials: (row.course_materials ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      subject: item.subject,
      tags: item.tags ?? [],
      source: item.source,
      excerpt: item.excerpt ?? undefined,
    })),
  }));
}

export async function saveCourseSection(section: CourseSection): Promise<void> {
  const { error } = await getClient().rpc('save_course_section', { p_section: section });
  if (error) throw new Error(`Could not save course data to Supabase: ${error.message}`);
}
