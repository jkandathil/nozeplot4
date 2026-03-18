const tf = require('@tensorflow/tfjs');
const xTrain = [];
try {
    const xsT = tf.tensor2d(xTrain);
    console.log(xsT.shape);
} catch (e) {
    console.log("Error empty xTrain:", e.message);
}

try {
    const xTrain2 = [[1, 2]];
    const xsT2 = tf.tensor2d(xTrain2);
    console.log("Valid shape:", xsT2.shape);
} catch (e) {
    console.log("Error valid xTrain:", e.message);
}
