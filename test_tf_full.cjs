const tf = require('@tensorflow/tfjs');

async function run() {
    try {
        const xTrain = [];
        const yTrain = [];
        for (let i=0; i<10; i++) {
            const row = [];
            for(let j=0; j<194; j++) row.push(Math.random());
            xTrain.push(row);
            yTrain.push(Math.random() * 50);
        }

        const means = [];
        const stds = [];
        for (let col = 0; col < 194; col++) {
            let sum = 0;
            for (let row = 0; row < xTrain.length; row++) sum += xTrain[row][col];
            const mean = sum / xTrain.length;
            let sumSq = 0;
            for (let row = 0; row < xTrain.length; row++) sumSq += Math.pow(xTrain[row][col] - mean, 2);
            const std = Math.sqrt(sumSq / xTrain.length) || 1e-6;
            means.push(mean);
            stds.push(std);
        }

        const scaleArray = (arr) => arr.map(row => row.map((val, col) => (val - means[col]) / stds[col]));

        const xsT = tf.tensor2d(scaleArray(xTrain));
        const ysT = tf.tensor2d(yTrain, [yTrain.length, 1]);

        const model = tf.sequential();
        model.add(tf.layers.dense({ units: 128, activation: 'elu', inputShape: [194] }));
        model.add(tf.layers.dropout({ rate: 0.1 }));
        model.add(tf.layers.dense({ units: 64, activation: 'elu' }));
        model.add(tf.layers.dense({ units: 32, activation: 'elu' }));
        model.add(tf.layers.dense({ units: 1, activation: 'linear' }));

        model.compile({
            optimizer: tf.train.adam(0.005),
            loss: 'meanSquaredError'
        });

        console.log("Starting fit");
        await model.fit(xsT, ysT, {
            epochs: 2,
            shuffle: true
        });
        console.log("Finished fit");
        
        const preds = model.predict(xsT).dataSync();
        console.log("Predictions:", preds);
    } catch (e) {
        console.error("Error:", e);
    }
}
run();
