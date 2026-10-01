import { expect, test } from '@playwright/test';

test('notification settings can be saved and a test reaches the inbox', async ({ page }) => {
  await page.goto('/settings/notifications');
  await page.getByRole('checkbox', { name: /Telegram/ }).check();
  await page.getByLabel('Quiet from').fill('22:00');
  await page.getByLabel('Quiet until').fill('07:00');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Notification settings saved.')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Telegram is on but can’t send yet: Add TELEGRAM_BOT_TOKEN to .env.' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('checkbox', { name: /Telegram/ })).toBeChecked();
  await expect(page.getByText('Add TELEGRAM_BOT_TOKEN to .env')).toBeVisible();

  await page.getByRole('button', { name: 'Send a test to the inbox' }).click();
  await expect(page.getByText('Test added to your inbox.')).toBeVisible();
  await page.goto('/notifications');
  await expect(page.getByTestId('notification').filter({ hasText: 'Test notification' })).toBeVisible();
  await expect(page.getByTestId('unread-badge')).toHaveText(/^[1-9]\d*$/);
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.getByTestId('inbox-link')).toHaveText('Inbox');
});

test('channel tests report what actually happened', async ({ page }) => {
  await page.goto('/settings/notifications');
  await page.getByLabel('Email notifications to').fill('me@example.com');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Notification settings saved.')).toBeVisible();
  // The test environment sends through the fixture SMTP server.
  await page.getByTestId('channel-email').getByRole('button', { name: 'Send test' }).click();
  await expect(page.getByTestId('channel-email').getByRole('status')).toContainText('Test sent to email.', { timeout: 15_000 });
  await page.reload();
  await expect(page.getByTestId('channel-email')).toContainText('Last sent');
  // Telegram isn't set up there: its test must say why.
  await page.getByTestId('channel-telegram').getByRole('button', { name: 'Send test' }).click();
  await expect(page.getByTestId('channel-telegram').getByRole('status')).toContainText(/Telegram test failed: Telegram is not set up/i, { timeout: 15_000 });

  // Headless Chromium always reports notifications as denied, so stand in for the browser's Notification API.
  await page.addInitScript(() => {
    const shown: string[] = [];
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string) {
        shown.push(title);
      }
    }
    Object.assign(window, { Notification: FakeNotification, __shown: shown });
  });
  await page.reload();
  await page.getByTestId('channel-browser').getByRole('button', { name: 'Send test' }).click();
  await expect(page.getByTestId('channel-browser').getByRole('status')).toContainText('Test shown by this browser.');
  expect(await page.evaluate(() => (window as unknown as { __shown: string[] }).__shown)).toContain('Test notification');
});

test('quiet hours need both times, and a failed save keeps what was typed', async ({ page }) => {
  await page.goto('/settings/notifications');
  await page.getByLabel('Quiet from').fill('23:00');
  await page.getByLabel('Quiet until').fill('');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/Set both “Quiet from” and “Quiet until”/)).toBeVisible();
  await expect(page.getByLabel('Quiet from')).toHaveValue('23:00');
});
