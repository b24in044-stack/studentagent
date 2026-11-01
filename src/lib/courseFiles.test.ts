import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedCourseFile, sanitizeCourseFileName } from './courseFiles';

test('allows only approved educational formats with their exact MIME type and size limit', () => {
  assert.equal(isAllowedCourseFile('notes.pdf', 'application/pdf', 100), true);
  assert.equal(isAllowedCourseFile('slides.pptx', 'application/pdf', 100), false);
  assert.equal(isAllowedCourseFile('archive.zip', 'application/zip', 100), false);
  assert.equal(isAllowedCourseFile('notes.txt', 'text/plain', 10 * 1024 * 1024 + 1), false);
});

test('sanitizes stored names and rejects unsupported extensions', () => {
  assert.equal(sanitizeCourseFileName('../week1/notes.pdf'), '.._week1_notes.pdf');
  assert.equal(sanitizeCourseFileName('script.exe'), null);
});
