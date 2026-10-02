import { test, expect } from '@playwright/test';
import { freshState } from '../data.js';
import { normalizeFight } from '../schedule-data.js';

const exportBout = {
  id: 'sample-export', red: { name: 'Pili' }, blue: { name: 'Katie Taylor' }, weightClass: '',
  roundsTotal: 10, roundLen: 120, rounds: [{ winner: 'blue', kd: { red: 0, blue: 0 }, ded: { red: 0, blue: 0 } }],
  status: 'done', result: { type: 'UD', winner: 'blue', round: null, note: '' },
  date: '2026-09-05T21:10:17.761Z', startedAt: '2026-09-05T21:10:17.763Z', endedAt: '2026-09-08T21:39:45.277Z', draft: null,
};
test.beforeEach(async ({ request }) => {
  const { user } = await (await request.get('/api/me')).json();
  const headers = { 'X-Scorecard-User': user.id };
  const current = await (await request.get('/api/state', { headers })).json();
  const response = await request.put('/api/state', { headers: { ...headers, Origin: 'http://localhost:8788' }, data: { revision: current.revision, state: freshState() } });
  expect(response.ok()).toBeTruthy();
});

test('legacy browser import, repeat import, and a fresh browser recover the same cloud history', async ({ page, browser }) => {
  const legacy = { ...freshState(), history: [exportBout] };
  await page.addInitScript((state) => localStorage.setItem('boxing-scorecard.v1', JSON.stringify(state)), legacy);
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/');
  await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  await page.getByRole('button', { name: 'Import old browser data' }).click();
  await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  await expect(page.getByText('Pili', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Import old browser data' }).click();
  await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  expect(await page.evaluate(() => window.__scorecard.state.history.length)).toBe(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('boxing-scorecard.v1')).history.length)).toBe(1);
  const other = await browser.newContext(); const fresh = await other.newPage();
  await fresh.goto('http://localhost:8788/');
  await expect(fresh.getByText('Pili', { exact: false }).first()).toBeVisible();
  await other.close();
});

test('JSON import preserves existing fields and duplicates do not create another scorecard', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/'); await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  const file = { name: 'history.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ exportedAt: '2026-10-02', bouts: [exportBout] })) };
  await page.locator('#history-file').setInputFiles(file);
  await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  await page.locator('#history-file').setInputFiles(file);
  await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  expect(await page.evaluate(() => window.__scorecard.state.history)).toEqual([exportBout]);
});

test('score an active fight offline, reconnect, and recover the draft after a reload', async ({ page, context }) => {
  await page.goto('/'); await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  await page.locator('[data-model="redName"]').fill('Red test');
  await page.locator('[data-model="blueName"]').fill('Blue test');
  await page.getByRole('button', { name: 'Start the bout' }).click();
  await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  await context.setOffline(true);
  await page.locator('[data-action="set-winner"][data-side="red"]').click();
  await expect(page.locator('#sync-status')).toHaveText('Cloud unavailable — changes saved on device');
  await context.setOffline(false);
  await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  await page.reload(); await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  expect(await page.evaluate(() => window.__scorecard.draft().winner)).toBe('red');
  await page.getByRole('button', { name: 'End bout', exact: true }).click();
  await page.getByRole('button', { name: 'Record result' }).click();
  await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  expect(await page.evaluate(() => window.__scorecard.state.history.length)).toBe(1);
});

test('two open devices prompt for a conflict instead of overwriting a scorecard', async ({ page, browser }) => {
  await page.goto('/'); await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  const other = await browser.newContext(); const second = await other.newPage();
  await second.goto('http://localhost:8788/'); await expect(second.locator('#sync-status')).toHaveText('Saved to cloud');
  await page.locator('[data-model="rounds"]').selectOption('12');
  await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  await second.locator('[data-model="rounds"]').selectOption('4');
  await expect(second.locator('#sync-status')).toHaveText('Changed on another device — review saves');
  await second.locator('#sync-status').click();
  await expect(second.getByText('Two devices have different saves')).toBeVisible();
  expect(await second.evaluate(() => window.__scorecard.state.prefs.rounds)).toBe(4);
  second.on('dialog', (dialog) => dialog.accept());
  await second.getByRole('button', { name: 'Use cloud copy' }).click();
  expect(await second.evaluate(() => window.__scorecard.state.prefs.rounds)).toBe(12);
  await other.close();
});

const scheduledFight = normalizeFight({
  id: 'scheduled-omari', date: '2026-10-03T03:00:00', scheduled_rounds: 8,
  fighters: { fighter_1: { full_name: 'Omari Jones', winner: true }, fighter_2: { full_name: 'Alan Sanchez', winner: false } },
  event: { id: 'project-series', title: 'Project Series: Jones vs Sanchez', date: '2026-10-03T00:00:00' },
  division: { name: 'Super Welterweight' }, venue: 'Caribe Royale Orlando', location: 'Orlando',
  results: { outcome: 'KO', round: 4 }, status: 'FINISHED', scores: ['secret-score'],
});
const missingFight = normalizeFight({
  id: 'missing-details', date: '2026-10-03T19:00:00',
  fighters: { fighter_1: { full_name: 'Boxer A' }, fighter_2: { full_name: 'Boxer B' } },
  event: { id: 'another-card', title: 'Another fight card', date: '2026-10-03' },
});

async function mockSchedule(page, fights = [scheduledFight, missingFight]) {
  await page.clock.setFixedTime(new Date('2026-10-02T12:00:00Z'));
  await page.route('**/api/schedule', (route) => route.fulfill({ json: { fights, days: 7, partial: false, stale: false, notice: null, fetchedAt: '2026-10-02T10:00:00Z' } }));
  await page.goto('/'); await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  await page.getByRole('button', { name: 'Browse fights' }).click();
  await expect(page.getByRole('button', { name: 'Select Omari Jones vs Alan Sanchez' })).toBeVisible();
}

test('a scheduled bout prefills fields, requires unknown round length, swaps corners, and saves its source separately from personal ID', async ({ page }) => {
  await mockSchedule(page);
  await page.getByRole('button', { name: 'Select Omari Jones vs Alan Sanchez' }).click();
  await expect(page.locator('[data-model="redName"]')).toHaveValue('Omari Jones');
  await expect(page.locator('[data-model="blueName"]')).toHaveValue('Alan Sanchez');
  await expect(page.locator('[data-model="weight"]')).toHaveValue('Super Welterweight');
  await expect(page.locator('[data-model="rounds"]')).toHaveValue('8');
  await expect(page.locator('[data-model="roundLen"]')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Start the bout' })).toBeDisabled();
  await expect(page.getByText('Corner assignments are not supplied.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Swap corners' }).click();
  await expect(page.locator('[data-model="redName"]')).toHaveValue('Alan Sanchez');
  await page.locator('[data-model="roundLen"]').selectOption('180');
  await page.getByRole('button', { name: 'Start the bout' }).click();
  await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  const active = await page.evaluate(() => window.__scorecard.state.active);
  expect(active.id).not.toBe(scheduledFight.id);
  expect(active.sourceFight.id).toBe(scheduledFight.id);
  expect(active.red.name).toBe('Alan Sanchez'); expect(active.roundsTotal).toBe(8);
  expect(active.result).toBeNull(); expect(active.rounds).toEqual([]);
  await page.reload(); await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  expect(await page.evaluate(() => window.__scorecard.state.active.sourceFight.id)).toBe(scheduledFight.id);
});

test('schedule search keeps focus, filters dates, and never displays provider results', async ({ page }) => {
  await mockSchedule(page);
  await expect(page.getByRole('heading', { name: 'Another fight card' })).toBeVisible();
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(page.getByText('No fights listed for today.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Next 7 days', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Find a fighter or event' });
  await search.fill('omari'); await expect(search).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Another fight card' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Select Omari Jones vs Alan Sanchez' })).toBeVisible();
  expect(await page.locator('#schedule-content').innerText()).not.toMatch(/secret-score|FINISHED|knockout|winner/i);
});

test('missing rounds remain unconfirmed; fields can be edited or selection cleared for manual entry', async ({ page }) => {
  await mockSchedule(page);
  await page.getByRole('button', { name: 'Select Boxer A vs Boxer B' }).click();
  await expect(page.locator('[data-model="rounds"]')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Start the bout' })).toBeDisabled();
  await expect(page.getByText('Weight class is not supplied', { exact: false })).toBeVisible();
  await page.locator('[data-model="rounds"]').selectOption('4');
  await page.locator('[data-model="roundLen"]').selectOption('120');
  await page.locator('[data-model="weight"]').fill('Lightweight');
  await expect(page.getByRole('button', { name: 'Start the bout' })).toBeEnabled();
  await page.getByRole('button', { name: 'Clear selection' }).click();
  await expect(page.locator('[data-model="redName"]')).toHaveValue('');
  await page.locator('[data-model="redName"]').fill('Manual red');
  await page.locator('[data-model="blueName"]').fill('Manual blue');
  await page.getByRole('button', { name: 'Start the bout' }).click();
  await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  expect(await page.evaluate(() => window.__scorecard.state.active.sourceFight)).toBeUndefined();
});

test('schedule errors leave manual scoring available', async ({ page }) => {
  await page.route('**/api/schedule', (route) => route.fulfill({ status: 503, json: { error: 'The schedule connection is unavailable. You can still enter a fight manually.' } }));
  await page.goto('/'); await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  await page.getByRole('button', { name: 'Browse fights' }).click();
  await expect(page.getByText('The schedule connection is unavailable.', { exact: false })).toBeVisible();
  await page.locator('[data-model="redName"]').fill('Manual red');
  await page.locator('[data-model="blueName"]').fill('Manual blue');
  await expect(page.getByRole('button', { name: 'Start the bout' })).toBeEnabled();
});

test('completed cards reveal paired official totals and the shared leaderboard', async ({ page }) => {
  await page.route('**/api/compare', route => route.fulfill({ json: { available: true, agreement: 90, error: 1, totals: { red: 98, blue: 92 }, average: { red: 97, blue: 93 }, scores: [{ red: 97, blue: 93 }, { red: 97, blue: 93 }, { red: 97, blue: 93 }], pairing: 'Paired using the official majority decision' } }));
  await page.route('**/api/leaderboard', route => route.fulfill({ json: { rows: [{ rank: 1, name: 'friend', agreement: 95, fights: 2, you: false }, { rank: 2, name: 'developer', agreement: 90, fights: 1, you: true }] } }));
  const bout = { ...exportBout, red: { name: 'A Boxer' }, blue: { name: 'B Boxer' }, sourceFight: { provider: 'boxing-data', id: 'fight', eventId: null, eventTitle: 'Test event', day: '2026-10-02', cornersConfirmed: false }, rounds: Array.from({ length: 10 }, (_, i) => ({ winner: i < 8 ? 'red' : 'blue', kd: { red: 0, blue: 0 }, ded: { red: 0, blue: 0 } })) };
  await page.goto('/'); await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  page.on('dialog', d => d.accept());
  await page.locator('#history-file').setInputFiles({ name: 'card.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ bouts: [bout] })) });
  await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  await page.getByRole('button', { name: 'Card', exact: true }).first().click();
  await expect(page.getByText('90.0% agreement')).toBeVisible();
  await expect(page.getByText('Judges’ average', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Leaderboard', exact: true }).last().click();
  await expect(page.getByText('developer · you', { exact: false })).toBeVisible();
  await expect(page.getByText('95.0%', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close leaderboard' }).click();
  await expect(page.getByText('90.0% agreement')).toBeVisible();
});

test('an unavailable official result keeps a card unranked and can be retried', async ({ page }) => {
  await page.route('**/api/compare', route => route.fulfill({ json: { available: false, reason: 'Official result is not available yet.' } }));
  page.on('dialog', d => d.accept());
  const bout = { ...exportBout, sourceFight: { provider: 'boxing-data', id: 'pending', eventId: null, eventTitle: 'Test event', day: '2026-10-02', cornersConfirmed: false }, rounds: Array.from({ length: 10 }, () => exportBout.rounds[0]) };
  await page.goto('/'); await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  await page.locator('#history-file').setInputFiles({ name: 'pending.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ bouts: [bout] })) });
  await expect(page.locator('#sync-status')).toHaveText('Saved to cloud');
  await page.getByRole('button', { name: 'Card', exact: true }).first().click();
  await expect(page.getByText('Official result is not available yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check official scores' })).toBeEnabled();
});
