import test from 'node:test';
import assert from 'node:assert/strict';

import { resolve } from 'node:path';
import { deferred, plain } from '../helpers/harness.mjs';
import { LIBRARY, serverPatch, setup } from '../helpers/admin-tags-page.mjs';

for (const remote of ['add', 'edit']) test(`Rules queued edits retain an unrelated concurrent ${remote}`, async t => {
  const A = '00000000000000000000000000000001', B = '00000000000000000000000000000002';
  const entry = (ItemId, Layout) => ({ ItemId, Layout, Density: 'full', LockedAt: 1 });
  const gate = deferred();
  let h;
  h = setup(t, {
    config: { TagLookItemOverrides: [entry(A, 'bands'), ...(remote === 'edit' ? [entry(B, 'caption')] : [])] },
    patch: async body => {
      if (h.patches.length === 1) {
        await gate.promise;
        h.server.TagLookItemOverrides = [...h.server.TagLookItemOverrides.filter(e => e.ItemId !== B), entry(B, 'minimal')];
      }
      return serverPatch(h.server, body);
    },
  });
  await h.settle();
  const edit = () => h.$(`[data-item="${A}"] [data-act="edit"]`).click();
  let onSave;
  h.JE.tagItemEditor = { open: (_, options) => { onSave = options.onSave; } };
  edit(); onSave({ layout: 'summary', density: 'full' }, A);
  const saving = h.ctx.flush();
  edit(); onSave({ layout: 'corners', density: 'compact' }, A);
  gate.resolve();
  assert.equal(await saving, true);
  const second = h.patches[1].Changes.TagLookItemOverrides;
  assert.deepEqual(second.Remove, [], 'no remote entry was removed by the queued edit');
  assert.deepEqual(second.Set.map(e => e.ItemId), [A]);
  assert.equal(h.server.TagLookItemOverrides.find(e => e.ItemId === B)?.Layout, 'minimal');
  assert.equal(h.ctx.config.TagLookItemOverrides.find(e => e.ItemId === B)?.Layout, 'minimal', 'response is rebased into the view');
});

for (const undo of [false, true]) test(`Rules Remove during a pending save preserves remote entries (Undo: ${undo})`, async t => {
  const A = '00000000000000000000000000000001', B = '00000000000000000000000000000002';
  const gate = deferred();
  let h;
  h = setup(t, {
    config: { TagLookItemOverrides: [{ ItemId: A, Layout: 'bands', Density: 'full', LockedAt: 1 }] },
    patch: async body => {
      if (h.patches.length === 1) {
        await gate.promise;
        h.server.TagLookItemOverrides.push({ ItemId: B, Layout: 'minimal', Density: 'full', LockedAt: 2 });
      }
      return serverPatch(h.server, body);
    },
  });
  await h.settle();
  let onSave;
  h.JE.tagItemEditor = { open: (_, options) => { onSave = options.onSave; } };
  h.$(`[data-item="${A}"] [data-act="edit"]`).click();
  onSave({ layout: 'summary', density: 'full' }, A);
  const saving = h.ctx.flush();
  h.$(`[data-item="${A}"] [data-act="remove"]`).click();
  if (undo) h.$('.je-ta-snack .je-ta-button').click();
  gate.resolve();
  assert.equal(await saving, true);
  assert.ok(h.server.TagLookItemOverrides.some(e => e.ItemId === B));
  assert.equal(h.server.TagLookItemOverrides.some(e => e.ItemId === A), undo);
  assert.ok(h.patches.every(p => !p.Changes.TagLookItemOverrides.Remove.includes(B)));
});


test('Rules canceled edit after a failed pending save resolves locally without retrying an empty mutation', async t => {
  const A = '00000000000000000000000000000001';
  const gate = deferred();
  const h = setup(t, {
    config: { TagLookItemOverrides: [{ ItemId: A, Layout: 'bands', Density: 'full', LockedAt: 1 }] },
    patch: async () => { await gate.promise; throw { status: 400, json: async () => ({ error: 'TagLookItemOverrides: rejected before applying' }) }; },
  });
  h.expectConsoleError('could not save the Media Tags settings');
  await h.settle();
  h.$(`[data-item="${A}"] [data-act="remove"]`).click();
  const saving = h.ctx.flush();
  h.$('.je-ta-snack .je-ta-button').click();
  gate.resolve();
  assert.equal(await saving, false);
  assert.equal(await h.ctx.flush(), true);
  assert.equal(h.patches.length, 1, 'Retry recognizes the canceled operation');
  assert.equal(h.$('#jeTaSaved').dataset.state, 'saved');
});

for (const failure of ['lost-response', '503-applied', '503-unapplied', '400-without-field']) test(`Rules Undo after ${failure} requires an acknowledging PATCH`, async t => {
  const A = '00000000000000000000000000000001';
  const entry = { ItemId: A, Layout: 'bands', Density: 'full', LockedAt: 1 };
  const gate = deferred(), retry = deferred();
  let h;
  h = setup(t, {
    config: { TagLookItemOverrides: [entry] },
    patch: async body => {
      if (h.patches.length === 1) {
        await gate.promise;
        if (failure === 'lost-response' || failure === '503-applied') serverPatch(h.server, body);
        if (failure === 'lost-response') throw new TypeError('response lost');
        throw { status: failure === '400-without-field' ? 400 : 503, json: async () => ({ error: 'unavailable' }) };
      }
      await retry.promise;
      return serverPatch(h.server, body);
    },
  });
  h.expectConsoleError('could not save the Media Tags settings');
  h.$(`[data-item="${A}"] [data-act="remove"]`).click();
  const saving = h.ctx.flush();
  h.$('.je-ta-snack .je-ta-button').click();
  gate.resolve();
  assert.equal(await saving, false);
  assert.equal(h.$('#jeTaSaved').dataset.state, 'error');
  const resaving = h.ctx.flush();
  assert.equal(h.patches.length, 2, 'Retry sends the retained restore intent');
  assert.equal(h.$('#jeTaSaved').dataset.state, 'saving', 'not saved before acknowledgement');
  retry.resolve();
  assert.equal(await resaving, true);
  assert.deepEqual(plain([...h.JE.core.tagLook.normalizeItemOverrides(h.server.TagLookItemOverrides)]), plain([...h.JE.core.tagLook.normalizeItemOverrides([entry])]));
  assert.equal(h.$('#jeTaSaved').dataset.state, 'saved');
});

for (const result of ['failure', 'success', 'conflict-mine', 'conflict-theirs']) test(`Rules edits during a pending replacement preserve whole-list intent after ${result}`, async t => {
  const A = '00000000000000000000000000000001', B = '00000000000000000000000000000002', C = '00000000000000000000000000000003';
  const entry = ItemId => ({ ItemId, Layout: 'bands', Density: 'full', LockedAt: 1 });
  const gate = deferred();
  let h;
  h = setup(t, {
    config: { TagLookItemOverrides: [entry(A)] },
    patch: async body => {
      if (h.patches.length === 1) {
        await gate.promise;
        if (result === 'failure') throw { status: 400, json: async () => ({ error: 'Invalid value for TagLookItemOverrides' }) };
        if (result.startsWith('conflict')) h.server.TagLookItemOverrides = [entry(A), { ...entry(C), Layout: 'minimal' }];
      }
      return serverPatch(h.server, body);
    },
  });
  if (result === 'failure') h.expectConsoleError('could not save the Media Tags settings');
  // The production import boundary writes a whole-list replacement.
  h.ctx.setMany({ TagLookItemOverrides: [entry(B), entry(C)] });
  const saving = h.ctx.flush();
  h.$(`[data-item="${B}"] [data-act="remove"]`).click();
  gate.resolve();
  assert.equal(await saving, result === 'success');
  if (result === 'failure') assert.equal(await h.ctx.flush(), true);
  if (result.startsWith('conflict')) {
    assert.equal(h.$('#jeTaSaved').dataset.state, 'conflict');
    h.$(result.endsWith('mine') ? '[data-je-keep]' : '[data-je-theirs]').click();
    await h.ctx.flush();
  }
  assert.deepEqual(h.server.TagLookItemOverrides.map(e => e.ItemId).sort(), result.endsWith('theirs') ? [A, C] : [C]);
  assert.ok(h.patches.every(p => Array.isArray(p.Changes.TagLookItemOverrides)), 'edits fold into the unacknowledged replacement');
  assert.equal(h.$('#jeTaSaved').dataset.state, 'saved');
});
