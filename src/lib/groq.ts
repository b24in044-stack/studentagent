import type { AiReview, CourseSection, StudentRecord } from './types';
import { buildLearningContext } from './rag';

export async function requestGroqReview(section: CourseSection, student: StudentRecord): Promise<AiReview> {
  const response = await fetch('/api/groq/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: buildLearningContext(section, student) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Groq review failed (${response.status}).`);
  return payload.review as AiReview;
}
