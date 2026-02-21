const names = [
    'BME_mpl_0000000027-4125-asu-nz_0ppb.csv',
    'normalized_ABGv5-50ppb-10RH-75ccm.csv'
];

const extractConcentration = (name) => {
    const basename = name.split('/').pop(); // Extract actual filename only
    const m = basename.match(/(\d+(?:\.\d+)?)\s*(ppb|ppm)/i);
    if (m) return `${parseFloat(m[1])} ${m[2].toLowerCase()}`;
    return 'Unknown';
};

names.forEach(n => console.log(n, '->', extractConcentration(n)));
