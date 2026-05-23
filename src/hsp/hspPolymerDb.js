/**
 * Polymer library with repeat-unit SMILES for HSP estimation.
 * Literature sphere values (when known) are from Hansen 2007 / HSPiP community data.
 *
 * Attachment convention: `0` marks backbone connection points (HSPiP style).
 */

export const HSP_POLYMER_MONOMERS = [
    {
        name: 'Polyethylene (PE)',
        abbrev: 'PE',
        repeatSmiles: '0CC0',
        category: 'polyolefin',
        dD: 16.9, dP: 0.8, dH: 2.8, R: 8.0,
        notes: 'LDPE reference sphere',
    },
    {
        name: 'Polypropylene (PP)',
        abbrev: 'PP',
        repeatSmiles: '0CC(C)0',
        category: 'polyolefin',
        dD: 17.4, dP: 1.9, dH: 4.7, R: 8.2,
    },
    {
        name: 'Polystyrene (PS)',
        abbrev: 'PS',
        repeatSmiles: '0CC(c1ccccc1)0',
        category: 'vinyl',
        dD: 21.3, dP: 5.8, dH: 4.3, R: 12.7,
    },
    {
        name: 'Poly(methyl methacrylate) (PMMA)',
        abbrev: 'PMMA',
        repeatSmiles: '0CC(C)(C(=O)OC)0',
        category: 'acrylic',
        dD: 18.6, dP: 10.5, dH: 7.5, R: 8.6,
    },
    {
        name: 'Polyvinyl chloride (PVC)',
        abbrev: 'PVC',
        repeatSmiles: '0CC(Cl)0',
        category: 'vinyl',
        dD: 17.6, dP: 7.8, dH: 3.4, R: 3.5,
    },
    {
        name: 'Polyvinyl acetate (PVAc)',
        abbrev: 'PVAc',
        repeatSmiles: '0CC(OC(C)=O)0',
        category: 'vinyl',
        dD: 20.9, dP: 11.3, dH: 9.6, R: 13.7,
    },
    {
        name: 'Polyacrylonitrile (PAN)',
        abbrev: 'PAN',
        repeatSmiles: '0CC(C#N)0',
        category: 'vinyl',
        dD: 21.7, dP: 14.1, dH: 9.1, R: 10.9,
    },
    {
        name: 'Polyamide 66 (Nylon-6,6)',
        abbrev: 'PA66',
        repeatSmiles: '0CCCCCC(=O)NCCCCC(=O)N0',
        category: 'polyamide',
        dD: 18.6, dP: 5.1, dH: 12.2, R: 10.0,
    },
    {
        name: 'Polycarbonate (PC)',
        abbrev: 'PC',
        repeatSmiles: '0Oc1ccc(C(C)(C)c2ccccc2)cc1C(=O)O0',
        category: 'engineering',
        dD: 18.1, dP: 5.9, dH: 6.9, R: 7.1,
        notes: 'Bisphenol-A PC repeat unit (approximate SMILES)',
    },
    {
        name: 'Polyetheretherketone (PEEK)',
        abbrev: 'PEEK',
        repeatSmiles: '0Oc1ccc(C(=O)c2ccc(O)c(C)c2)cc1C0',
        category: 'engineering',
        dD: 19.7, dP: 9.4, dH: 7.4, R: 7.6,
        notes: 'Approximate repeat unit',
    },
    {
        name: 'Polysulfone (PSU)',
        abbrev: 'PSU',
        repeatSmiles: '0Oc1ccc(S(=O)(=O)c2ccc(O)c(C)c2)cc1C0',
        category: 'engineering',
        dD: 19.7, dP: 8.3, dH: 8.3, R: 8.0,
        notes: 'Udel-type repeat unit (approximate)',
    },
    {
        name: 'Polydimethylsiloxane (PDMS)',
        abbrev: 'PDMS',
        repeatSmiles: '0O[Si](C)(C)0',
        category: 'silicone',
        dD: 15.9, dP: 0.1, dH: 4.7, R: 6.0,
    },
    {
        name: 'Epoxy (DGEBA)',
        abbrev: 'EP',
        repeatSmiles: '0CC(O)CC(O)c1ccccc1C0',
        category: 'thermoset',
        dD: 17.4, dP: 10.5, dH: 9.0, R: 11.8,
        notes: 'DGEBA-type repeat unit (approximate)',
    },
    {
        name: 'Polyurethane (Estane)',
        abbrev: 'PU',
        repeatSmiles: '0NC(=O)OCCOC(=O)N0',
        category: 'urethane',
        dD: 19.0, dP: 9.7, dH: 7.2, R: 9.0,
        notes: 'Generic urethane linkage repeat',
    },
    {
        name: 'Cellulose acetate (CA)',
        abbrev: 'CA',
        repeatSmiles: '0OC1C(OC(C)=O)C(OC(C)=O)C(OC(C)=O)C1O0',
        category: 'cellulose',
        dD: 18.6, dP: 12.7, dH: 11.0, R: 7.6,
        notes: 'Tri-acetate repeat unit (approximate)',
    },
    {
        name: 'Polyethylene terephthalate (PET)',
        abbrev: 'PET',
        repeatSmiles: '0OC(=O)c1ccc(C(=O)OCC)cc10',
        category: 'polyester',
        dD: 19.5, dP: 8.6, dH: 5.5, R: 6.5,
        notes: 'Literature sphere (approximate)',
    },
    {
        name: 'Polybutadiene (PB)',
        abbrev: 'PB',
        repeatSmiles: '0CC=CC0',
        category: 'elastomer',
        dD: 17.0, dP: 1.5, dH: 3.5, R: 9.0,
    },
    {
        name: 'Polyisoprene (PI)',
        abbrev: 'PI',
        repeatSmiles: '0CC(=C)C0',
        category: 'elastomer',
        dD: 16.8, dP: 2.0, dH: 4.0, R: 9.5,
    },
    {
        name: 'Poly(ethylene oxide) (PEO)',
        abbrev: 'PEO',
        repeatSmiles: '0CCO0',
        category: 'polyether',
        dD: 17.2, dP: 9.2, dH: 8.0, R: 8.5,
    },
    {
        name: 'Polylactic acid (PLA)',
        abbrev: 'PLA',
        repeatSmiles: '0OC(=O)C(C)0',
        category: 'polyester',
        dD: 18.0, dP: 10.0, dH: 8.0, R: 7.0,
    },
];

/** Build AB, AABB, or AAABBB copolymer SMILES from two monomer repeat units. */
export function buildCopolymerSmiles(smilesA, smilesB, pattern = 'AB') {
    const a = String(smilesA || '').replace(/\[\*\]|\*/g, '0');
    const b = String(smilesB || '').replace(/\[\*\]|\*/g, '0');
    const strip = (s) => s.replace(/0/g, '');
    const coreA = strip(a);
    const coreB = strip(b);
    if (pattern === 'AABB') return `0${coreA}${coreA}${coreB}${coreB}0`;
    if (pattern === 'AAABBB') return `0${coreA.repeat(3)}${coreB.repeat(3)}0`;
    return `0${coreA}${coreB}0`;
}

export function findPolymerByName(name) {
    if (!name) return null;
    const q = String(name).toLowerCase();
    return HSP_POLYMER_MONOMERS.find(
        (p) => p.name.toLowerCase() === q || p.abbrev.toLowerCase() === q
    ) ?? null;
}

/** Categories for filter UI. */
export const POLYMER_CATEGORIES = [...new Set(HSP_POLYMER_MONOMERS.map((p) => p.category))].sort();
