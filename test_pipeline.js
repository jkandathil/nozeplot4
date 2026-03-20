import { processAromaBatchCore } from './src/utils/aromaAnalysisPipeline.js';

async function run() {
    const parsed = {
        data: [
            { 'A1 (123)': 10.5 },
            { 'A1 (123)': 10.7 }
        ],
        fileName: 'test.csv'
    };

    const config = {
        sensingElements: 'A1',
        tempCols: '',
        humCols: '',
        filterWindow: 1,
        baselinePts: 50,
        separateByUnit: false
    };

    const plots = await processAromaBatchCore([parsed], config);
    console.log(JSON.stringify(plots[0]?.data?.[0], null, 2));
}

run();
