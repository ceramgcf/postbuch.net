import test from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUT_GRENZE, entscheideLayout } from '../src/lib/darstellung.js';

test('Layout folgt allein der Breite', () => {
  assert.equal(entscheideLayout(390), 'mobil');
  assert.equal(entscheideLayout(844), 'mobil');
  assert.equal(entscheideLayout(LAYOUT_GRENZE - 1), 'mobil');
  assert.equal(entscheideLayout(LAYOUT_GRENZE), 'desktop');
  assert.equal(entscheideLayout(1366), 'desktop');
});
