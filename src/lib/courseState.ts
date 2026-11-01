export type CourseViewState = 'error' | 'empty' | 'ready';

export function getCourseViewState(sectionCount: number, loadError: string): CourseViewState {
  if (loadError) return 'error';
  return sectionCount === 0 ? 'empty' : 'ready';
}
