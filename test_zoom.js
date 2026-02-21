import puppeteer from 'puppeteer';

(async () => {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    
    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('pageerror', err => console.log('BROWSER ERROR:', err.message));
    
    await page.goto('http://localhost:5173/nozeplot4/', { waitUntil: 'networkidle2' }).catch(e => console.log(e));
    
    // Check if the app loaded
    const body = await page.content();
    console.log("App loaded. Has data?", body.includes('ChartArea'));
    
    await browser.close();
})();
