import test from 'node:test';
import assert from 'node:assert/strict';
import { coverage } from '../../../scripts/tag-translation-coverage.mjs';

// Untranslated Media Tags strings fall back to English (Weblate fills them); a translated one must keep
// every {placeholder} of the English string, or the chip would show a raw brace or lose its number.
test('every shipped locale is reported and its translated Media Tags strings keep their placeholders', () => {
  const rows = coverage();
  assert.ok(rows.length >= 30);
  for (const row of rows) {
    assert.ok(row.total > 600, `${row.locale} total`);
    assert.ok(row.translated <= row.total);
    assert.deepEqual(row.placeholderErrors, [], `${row.locale} placeholders`);
  }
});
