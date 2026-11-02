/**
 * Visual and accessibility sweep: signs in as each role, visits every page, saves a full-page screenshot
 * (test-results/screens/<project>/), runs axe (WCAG 2.1 AA) and fails on serious/critical issues or console errors.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const DATA = path.resolve(import.meta.dirname, '../.test-data');
const MOBILE: Record<string, string> = { director: '9000000001', manager: '9000000002', employee: '9000000003', client: '9000000004' };
const creds = () => Object.fromEntries(fs.readFileSync(path.join(DATA, 'initial-credentials.txt'), 'utf8').split('\n').filter((l) => l.includes('password:'))
  .map((l) => { const m = l.match(/^(\w+)\s+(\S+)\s+password: (\S+)/)!; return [m[1], { email: m[2], pw: m[3] }]; }));

async function login(page: Page, role: string) {
  await page.goto('/');
  if (role === 'client') {
    await page.getByLabel(/Registered mobile number/).fill(MOBILE.client);
    await page.getByRole('button', { name: 'Send one-time code' }).click();
  } else {
    await page.getByRole('radio', { name: /Firm staff/ }).click();
    await page.getByLabel('Work email').fill(creds()[role].email);
    await page.getByLabel('Password').fill(creds()[role].pw);
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(page.getByText('Enter your code')).toBeVisible();
  const code = JSON.parse(fs.readFileSync(path.join(DATA, 'dev-otp.json'), 'utf8'))[MOBILE[role]];
  await page.getByLabel('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  const ack = page.getByRole('button', { name: 'I have read this' });
  await Promise.race([ack.waitFor({ timeout: 5000 }).then(() => ack.click()).catch(() => {}), page.locator('#main').waitFor()]);
  await page.locator('#main').waitFor();
}

const apiGet = (page: Page, p: string) => page.evaluate(async (u) => (await fetch(`/api${u}`, { headers: { 'X-Requested-With': 'fetch' } })).json(), p);

async function sweep(page: Page, role: string, pages: [string, string][], project: string) {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|favicon/.test(m.text())) errors.push(`${page.url()}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
  const problems: string[] = [];
  for (const [name, url] of pages) {
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    // Let entrance animations finish (including the off-screen safety reveal) before measuring contrast.
    await page.waitForTimeout(2200);
    const dir = `test-results/screens/${project}`;
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/${role}-${name}.png`, fullPage: true });
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    for (const v of axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')) {
      problems.push(`${role}/${name}: ${v.id} (${v.impact}) ${v.help} → ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
    }
  }
  if (problems.length) console.log(problems.join('\n'));
  expect.soft(problems, 'accessibility').toEqual([]);
  expect.soft(errors, 'console errors').toEqual([]);
}

test('login screen', async ({ page }, info) => {
  await page.goto('/');
  await page.waitForTimeout(900);
  fs.mkdirSync(`test-results/screens/${info.project.name}`, { recursive: true });
  await page.screenshot({ path: `test-results/screens/${info.project.name}/login.png`, fullPage: true });
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
});

test('director', async ({ page }, info) => {
  await login(page, 'director');
  const company = (await apiGet(page, '/companies'))[0];
  const task = (await apiGet(page, '/tasks')).find((t: { title: string }) => t.title.startsWith('GSTR-3B'));
  await sweep(page, 'director', [
    ['dashboard', '/'], ['clients', '/clients'], ['company-docs', `/company/${company.id}`], ['company-reports', `/company/${company.id}?tab=reports`],
    ['tasks', '/tasks'], ['task-detail', `/tasks/${task.id}`], ['review', '/review'], ['time', '/time'], ['team', '/team'],
    ['tally', '/tally'], ['audit', '/audit'], ['privacy', '/privacy'],
  ], info.project.name);
});

test('employee', async ({ page }, info) => {
  await login(page, 'employee');
  await sweep(page, 'employee', [['dashboard', '/'], ['tasks', '/tasks'], ['time', '/time']], info.project.name);
});

test('client', async ({ page }, info) => {
  await login(page, 'client');
  const company = (await apiGet(page, '/companies'))[0];
  await sweep(page, 'client', [
    ['home', '/'], ['reports', `/company/${company.id}?tab=reports`], ['documents', `/company/${company.id}?tab=docs`],
    ['requests', '/requests'], ['privacy', '/privacy'],
  ], info.project.name);
});
