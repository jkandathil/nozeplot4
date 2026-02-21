const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
    const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox'] });
    const page = await browser.newPage();
    
    // Log all errors and console messages
    page.on('console', msg => console.log('BROWSER LOG:', msg.type(), msg.text()));
    page.on('pageerror', err => console.log('CRASH:', err.message));
    page.on('response', response => {
        if (!response.ok()) console.log(`HTTP ERR: ${response.url()}`);
    });

    try {
        await page.goto('http://localhost:5173/nozeplot4/', { waitUntil: 'load', timeout: 30000 });
        console.log("Page loaded. Looking for input elements...");
        
        // Wait briefly for react to mount
        await new Promise(r => setTimeout(r, 2000));
        
        // Wait for potential specific inputs
        const buttons = await page.$$('button');
        console.log("Found buttons:", buttons.length);
        
        // Expose a function to window so we can trigger the crash if it's based on data
        await page.evaluate(() => {
            console.log("EVAL IN PAGE.");
        });

        // We can't automatically upload unless we find an input[type=file]. Let's look for one.
        const fileInput = await page.$('input[type="file"]');
        if(fileInput) {
            console.log("Found file input, uploading mock...");
            await fileInput.uploadFile('./mock_data.csv');
            await new Promise(r => setTimeout(r, 2000));
            // try dragging the chart
            console.log("Looking for chart...");
            const chart = await page.$('.recharts-wrapper');
            if (chart) {
                const box = await chart.boundingBox();
                console.log("Dragging chart from", box.x + 50, "to", box.x + 100);
                await page.mouse.move(box.x + 50, box.y + 50);
                await page.mouse.down();
                await page.mouse.move(box.x + 100, box.y + 50);
                await page.mouse.up();
                await new Promise(r => setTimeout(r, 2000));
            }
        } else {
            console.log("No file input found to upload mock data.");
        }
    } catch(err) {
        console.log("Puppeteer Error:", err);
    }
    
    await browser.close();
})();
