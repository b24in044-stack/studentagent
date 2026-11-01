import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getCourseViewState } from './courseState';

describe('Course dashboard state', () => {
  it('distinguishes a successful empty result from a failed request', () => {
    assert.equal(getCourseViewState(0, ''), 'empty');
    assert.equal(getCourseViewState(0, 'Could not load courses.'), 'error');
    assert.equal(getCourseViewState(1, ''), 'ready');
  });
});
