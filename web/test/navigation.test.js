import test from 'node:test';
import assert from 'node:assert/strict';
import { bildeNavigation, titelFuerPfad, istAktiv } from '../src/lib/navigation.js';

const ziele = (items) => items.map(i => i.to);

test('eingeschränkte Konten sehen nur Dokumente und Suche', () => {
  const nav = bildeNavigation({ istEingeschraenkt: true, hasInsuredPerson: true });
  assert.deepEqual(ziele(nav.haupt), ['/postbuch', '/search']);
  assert.deepEqual(nav.gruppen, []);
  assert.deepEqual(ziele(nav.favoriten), ['/postbuch', '/search']);
});

test('nav_visibility blendet Logs und Salden für Nicht-Admins aus', () => {
  const nav = bildeNavigation({ navVis: { logs: false, salden: false } });
  assert.ok(!ziele(nav.haupt).includes('/logs'));
  assert.ok(!nav.gruppen.flatMap(g => ziele(g.items)).includes('/analyse/salden'));
  const admin = bildeNavigation({ isAdmin: true, navVis: { logs: false, salden: false } });
  assert.ok(ziele(admin.haupt).includes('/logs'));
});

test('Krankenversicherung nur mit versicherter Person, Favoriten fest', () => {
  assert.equal(bildeNavigation().gruppen.length, 1);
  assert.equal(bildeNavigation({ hasInsuredPerson: true }).gruppen[0].titel, 'Krankenversicherung');
  assert.deepEqual(ziele(bildeNavigation().favoriten), ['/', '/postbuch', '/search', '/analyse/wiedervorlagen']);
});

test('Titel und Aktiv-Zustand aus dem Pfad', () => {
  assert.equal(titelFuerPfad('/'), 'Dashboard');
  assert.equal(titelFuerPfad('/postbuch'), 'Dokumente');
  assert.equal(titelFuerPfad('/postbuch/P000123'), 'Dokument');
  assert.equal(titelFuerPfad('/analyse/salden'), 'Salden');
  assert.equal(titelFuerPfad('/analyse/salden/7'), 'Saldo');
  assert.equal(titelFuerPfad('/akten/A000123'), 'Akte');
  assert.equal(titelFuerPfad('/akten/originale'), 'Akten');
  assert.ok(istAktiv('/', '/'));
  assert.ok(!istAktiv('/', '/postbuch'));
  assert.ok(istAktiv('/postbuch', '/postbuch/P000123'));
});
