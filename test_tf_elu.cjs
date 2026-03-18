const tf = require('@tensorflow/tfjs');
try {
    const model = tf.sequential();
    model.add(tf.layers.dense({ units: 128, activation: 'elu', inputShape: [194] }));
    model.add(tf.layers.dropout({ rate: 0.1 }));
    model.add(tf.layers.dense({ units: 64, activation: 'elu' }));
    model.add(tf.layers.dense({ units: 32, activation: 'elu' }));
    model.add(tf.layers.dense({ units: 1, activation: 'linear' }));
    console.log("Model built successfully");
} catch (e) {
    console.log("Error:", e.message);
}
