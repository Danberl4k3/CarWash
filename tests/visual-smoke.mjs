import 'dotenv/config';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const baseUrl = process.env.VISUAL_BASE_URL ?? 'http://127.0.0.1:3100';
const executablePath = process.env.BROWSER_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const username = process.env.VISUAL_ADMIN_USERNAME ?? process.env.ADMIN_USERNAME ?? 'admin';
const password = process.env.VISUAL_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? 'local-ui-test-password';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  const dimensions = await mobile.evaluate(() => ({
    viewport: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    title: document.title,
  }));
  if (dimensions.scrollWidth > dimensions.viewport) {
    throw new Error(`Mobile page overflows horizontally: ${JSON.stringify(dimensions)}`);
  }
  await mobile.locator('#booking-form').evaluate((form) => form.removeAttribute('inert'));
  await mobile.locator('input[name="vehicleType"][value="motorcycle"]').check({ force: true });
  const motorcycleSelection = await mobile.locator('input[name="baseServiceId"]:checked').getAttribute('data-slug');
  if (motorcycleSelection !== 'motorcycle-wash') {
    throw new Error(`Motorcycle selection did not switch service: ${motorcycleSelection}`);
  }
  if (!(await mobile.locator('[data-plate-photo]').count())) throw new Error('Plate photo input is missing');
  const tablet = await browser.newPage({ viewport: { width: 768, height: 1024 } });
  await tablet.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  const tabletDimensions = await tablet.evaluate(() => ({ viewport: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  if (tabletDimensions.scrollWidth > tabletDimensions.viewport) throw new Error(`Tablet page overflows horizontally: ${JSON.stringify(tabletDimensions)}`);
  await mobile.screenshot({ path: 'artifacts/mobile-playwright.png', fullPage: true });

  const admin = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await admin.goto(`${baseUrl}/admin/login`);
  await admin.locator('input[name="username"]').fill(username);
  await admin.locator('input[name="password"]').fill(password);
  await Promise.all([
    admin.waitForURL('**/admin'),
    admin.locator('button[type="submit"]').click(),
  ]);
  const dashboard = await admin.evaluate(() => ({
    title: document.title,
    heading: document.querySelector('h1')?.textContent?.trim(),
    columns: document.querySelectorAll('.pickup-column').length,
  }));
  if (dashboard.heading !== 'Panel de recojos' || dashboard.columns !== 11) {
    throw new Error(`Unexpected admin dashboard: ${JSON.stringify(dashboard)}`);
  }
  await admin.screenshot({ path: 'artifacts/admin-dashboard.png', fullPage: true });
  console.log({ mobile: dimensions, admin: dashboard });
} finally {
  await browser.close();
}
