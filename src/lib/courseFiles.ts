export const MAX_COURSE_FILE_BYTES = 10 * 1024 * 1024;

const allowedTypes: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
};

export function getAllowedCourseFileType(fileName: string): string | null {
  const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  return allowedTypes[extension] ?? null;
}

export function isAllowedCourseFile(fileName: string, contentType: string, size: number): boolean {
  const expectedType = getAllowedCourseFileType(fileName);
  return Boolean(expectedType)
    && contentType.toLowerCase() === expectedType
    && Number.isFinite(size)
    && size > 0
    && size <= MAX_COURSE_FILE_BYTES;
}

export function sanitizeCourseFileName(fileName: string): string | null {
  const normalized = fileName
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .slice(0, 180);
  return normalized && getAllowedCourseFileType(normalized) ? normalized : null;
}
