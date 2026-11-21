import { expect, test } from '@playwright/test';

for (const width of [375, 768, 1440]) {
  for (const path of ['/', '/pool']) {
    test(`no horizontal overflow on ${path} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
}
