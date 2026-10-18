import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, button, deferred, load, mount, ui, wrap } from './helpers/render.mjs';

const draft = { id: 'saved-id', apiUrl: 'https://api.example', photoUri: 'file:///saved.jpg', mime: 'image/jpeg', fields: { title: 'Waste' } };
const accepted = { id: draft.id, public_reference: 'WG-ABCDEF123456', title: 'Waste', display_status: 'submitted', assessment_status: 'pending' };

function screen({ sendDraft, createDraft = async () => draft, session = null } = {}) {
  let camera, form, receipt, currentSession = session;
  const navigation = [];
  const created = [];
  const sent = [];
  const Report = load('app/report.tsx', {
    'expo-router': { router: { replace: path => navigation.push(path), back() {} } },
    '@/services/reports': {
      createDraft: async (...args) => { created.push(args); return createDraft(...args); },
      sendDraft: async saved => { sent.push(saved); return sendDraft(saved); },
      discardDraft: async () => {},
    },
    '@/services/report-client': { reportFields: (caption, location) => {
      if (!caption.trim() || !location?.coords) throw new Error('Incomplete');
      return { title: caption, latitude: String(location.coords.latitude), longitude: String(location.coords.longitude) };
    }, ReportRejectedError: class extends Error {} },
    '@/auth/session': { getSession: () => currentSession, useSession: () => currentSession },
    '@/components/report/camera-step': { CameraStep: props => { camera = props; return null; } },
    '@/components/report/report-form': { ReportForm: props => { form = props; return null; } },
    '@/components/report/submission-receipt': { SubmissionReceipt: props => { receipt = props; return React.createElement('div', null, props.reference); } },
    '@/utils/describe-photo': { describePhoto: async () => null },
    '@/utils/location': { getPhotoLocation: async () => ({ coords: { latitude: 24.9, longitude: 67.1 }, address: '' }) },
  }).default;
  const view = mount(Report, {});
  return {
    view, navigation, created, sent,
    form: () => form, receipt: () => receipt,
    setSession: value => { currentSession = value; },
    async ready() {
      await view.render();
      await act(async () => camera.onCapture('file:///photo.jpg'));
      await act(() => form.onCaptionChange('Waste'));
      assert.equal(form.canSubmit, true);
    },
  };
}

test('accepted anonymous submission shows its reference before optional history navigation', async () => {
  const app = screen({ sendDraft: async () => accepted });
  try {
    await app.ready();
    await act(async () => app.form().onSubmit());
    assert.equal(app.receipt()?.reference, accepted.public_reference);
    assert.equal(app.navigation.length, 0);
    assert.equal(app.created.length, 1);
    assert.equal(app.sent.length, 1);
    await act(() => app.receipt().onHistory());
    assert.deepEqual(app.navigation, ['/(tabs)/reports']);
  } finally { await app.view.close(); }
});

test('timeout keeps the saved draft and recovered idempotent acceptance shows its reference', async () => {
  let attempts = 0;
  const app = screen({ sendDraft: async () => {
    if (++attempts === 1) throw new Error('Unable to confirm this upload. Keep the saved draft and retry.');
    return accepted;
  } });
  try {
    await app.ready();
    await act(async () => app.form().onSubmit());
    assert.equal(app.receipt(), undefined);
    assert.match(app.form().error, /Unable to confirm this upload/);
    assert.equal(app.form().frozen, true);
    assert.equal(app.navigation.length, 0);
    await act(async () => app.form().onSubmit());
    assert.equal(app.receipt()?.reference, accepted.public_reference);
    assert.equal(app.created.length, 1);
    assert.equal(app.sent.length, 2);
    assert.strictEqual(app.sent[0], app.sent[1]);
  } finally { await app.view.close(); }
});

test('a repeated tap during submission sends one saved draft', async () => {
  const pending = deferred();
  const app = screen({ sendDraft: () => pending.promise });
  try {
    await app.ready();
    await act(() => { void app.form().onSubmit(); void app.form().onSubmit(); });
    assert.equal(app.created.length, 1);
    await act(async () => { pending.resolve(accepted); await pending.promise; });
    assert.equal(app.sent.length, 1);
    assert.equal(app.receipt()?.reference, accepted.public_reference);
  } finally { await app.view.close(); }
});

test('a late accepted response cannot show a receipt after unmount or account switch', async () => {
  for (const change of ['unmount', 'account']) {
    const pending = deferred();
    const app = screen({ sendDraft: () => pending.promise });
    await app.ready();
    await act(() => { void app.form().onSubmit(); });
    assert.equal(app.sent.length, 1);
    if (change === 'unmount') await app.view.close();
    else { app.setSession({ userId: 'another-account' }); await app.view.render(); }
    await act(async () => { pending.resolve(accepted); await pending.promise; });
    assert.equal(app.receipt(), undefined);
    assert.deepEqual(app.navigation, []);
    if (change === 'account') { assert.equal(app.form().frozen, true); await app.view.close(); }
  }
});

test('an accepted anonymous receipt stays hidden after an account changes and signs out', async () => {
  const app = screen({ sendDraft: async () => accepted });
  try {
    await app.ready();
    await act(async () => app.form().onSubmit());
    assert.match(app.view.container.textContent, /WG-ABCDEF123456/);
    app.setSession({ userId: 'another-account' });
    await app.view.render();
    assert.doesNotMatch(app.view.container.textContent, /WG-ABCDEF123456/);
    app.setSession(null);
    await app.view.render();
    assert.doesNotMatch(app.view.container.textContent, /WG-ABCDEF123456/);
  } finally { await app.view.close(); }
});

test('receipt exposes only a selectable public reference and explains gated history', async () => {
  const Receipt = load('components/report/submission-receipt.tsx', {
    '@/components/ui': {
      ...ui, Card: wrap, Screen: wrap,
      ScreenHeader: props => React.createElement('h1', null, props.title),
      AppText: props => React.createElement('span', { 'data-selectable': props.selectable ? 'true' : undefined }, props.children),
    },
  }).SubmissionReceipt;
  const paths = [];
  const view = mount(Receipt, { reference: accepted.public_reference, onHistory: () => paths.push('history'), onDone: () => paths.push('done') });
  try {
    await view.render();
    assert.match(view.container.textContent, /Report received/);
    assert.equal(view.container.querySelector('[data-selectable="true"]').textContent, accepted.public_reference);
    assert.match(view.container.textContent, /requires logging in and explicitly importing reports saved on this device/);
    assert.doesNotMatch(view.container.textContent, /wg_r_|token|file:\/\//i);
    await act(() => button(view.container, 'Done').click());
    assert.deepEqual(paths, ['done']);
  } finally { await view.close(); }
});
