const { RandomForestRegression } = require('ml-random-forest');
const rf = new RandomForestRegression();
try { rf.train([], []); } catch (e) { console.log(e.message); }
