import type { CourseSection } from './types';

export type StudentProfile = {
  id: string;
  name: string;
  rollNo: string;
};

export async function fetchStudentProfile(): Promise<StudentProfile> {
  throw new Error('Supabase support was removed. Use the Firebase data-access services in src/lib/firebaseData.ts instead.');
}

export async function fetchCourseSections(): Promise<CourseSection[]> {
  return [];
}

export async function saveCourseSection(): Promise<void> {
  throw new Error('Supabase support was removed. Use Firebase Firestore services instead.');
}
