const puppeteer = require('puppeteer');
(async () => {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('http://localhost:5173/nozeplot4/', { waitUntil: 'networkidle2' });
    const body = await page.content();
    if (body.includes('Something went wrong')) {
        console.log("CRASH DETECTED ON LOAD!");
        const err = await page.$eval('pre', el => el.innerText);
        console.log("Error:", err);
    } else {
        console.log("No crash on load.");
    }
    await browser.close();
})();
