const fs = require('fs');
let csv = 'index,val1,val2\n';
for(let i = 0; i < 1000; i++) {
    csv += `${i},${Math.random()},${Math.random() * 10}\n`;
}
fs.writeFileSync('mock_data.csv', csv);
