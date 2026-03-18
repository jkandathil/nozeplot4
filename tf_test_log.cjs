const tf = require('@tensorflow/tfjs');
const xTrain = [[1, 2], [3, 4]];
for (let i = 0; i < 10; i++) xTrain.push([Math.random(), Math.random()]);

const means = [];
const stds = [];
for (let col = 0; col < 2; col++) {
    let sum = 0;
    for (let row = 0; row < xTrain.length; row++) sum += xTrain[row][col];
    const mean = sum / xTrain.length;
    let sumSq = 0;
    for (let row = 0; row < xTrain.length; row++) sumSq += Math.pow(xTrain[row][col] - mean, 2);
    const std = Math.sqrt(sumSq / xTrain.length) || 1e-6; // Prevent div by 0
    means.push(mean);
    stds.push(std);
}

const scaleArray = (arr) => arr.map(row => row.map((val, col) => (val - means[col]) / stds[col]));
console.log("Means:", means);
console.log("Stds:", stds);
console.log("Scaled Array:", scaleArray(xTrain));
