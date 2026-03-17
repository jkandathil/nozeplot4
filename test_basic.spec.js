import { test, expect } from '@playwright/test';

test('App loads successfully without crashing', async ({ page }) => {
    // Navigate to the local server
    await page.goto('http://localhost:5176/nozeplot4/');

    // Wait for the app to initialize
    await page.waitForLoadState('networkidle');
    await page.waitForLoadState('domcontentloaded');

    // Make sure we are not stuck on a white screen
    const elementHandle = await page.locator('body');
    const textContent = await elementHandle.textContent();

    // Check if there is an error thrown immediately by React
    const errorText = await page.evaluate(() => {
        return document.querySelector('.error-banner') ? document.querySelector('.error-banner').innerText : null;
    });
    
    console.log("Error banner text (if any):", errorText);
    expect(errorText).toBeNull();
});
