import type { AiReview, CourseSection, StudentRecord } from './types';
import { auth } from './firebase';
import { readApiResponse } from './apiResponse';

export async function requestGroqReview(section: CourseSection, student: StudentRecord): Promise<AiReview> {
  const user = auth?.currentUser;
  if (!user) throw new Error('Sign in before requesting a learning review.');
  const idToken = await user.getIdToken();
  const response = await fetch('/api/groq/review', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sectionId: section.id, studentId: student.id }),
  });
  const payload = await readApiResponse<{ review?: AiReview }>(response, 'Groq review');
  if (!payload.review) throw new Error('The server returned no learning review. Please retry.');
  return payload.review;
}
