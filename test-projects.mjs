// Unit tests for the Circuit Studio project storage layer.
// We stub a minimal in-memory localStorage so we can exercise the
// whole CRUD + migration pipeline without a browser.

const mem = new Map();
globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => mem.clear(),
    get length() { return mem.size; },
    key: (i) => [...mem.keys()][i] || null,
};

const proj = await import('./src/circuit/projects.js');
const {
    listProjects, loadProject, saveProject, deleteProject,
    renameProject, duplicateProject,
    getCurrentProjectId, setCurrentProjectId,
    loadInitialProject, migrateLegacySingleSlot,
    importProjectJson, toExportEnvelope, uniqueName, formatUpdatedAt,
} = proj;

let failed = 0;
function ok(label, cond, extra = '') {
    if (cond) console.log(`  ✓ ${label}`);
    else { console.log(`  ✗ ${label} ${extra}`); failed++; }
}

function reset() {
    mem.clear();
}

function sampleDoc(n = 2) {
    return {
        components: Array.from({ length: n }, (_, i) => ({
            id: `u${i}`, partId: 'R', elementType: 'R',
            symbolKey: 'R', pos: { x: 40, y: 40 }, rot: 0,
            ref: `R${i + 1}`, value: 1000,
        })),
        wires: [],
        labels: [],
        userModels: [],
        directives: [],
        meta: { nextUid: 3, refCounts: { R: n } },
    };
}

/* ---------------- tests ---------------- */

console.log('saveProject / listProjects:');
reset();
{
    const a = saveProject({ name: 'Alpha', doc: sampleDoc(3) });
    const b = saveProject({ name: 'Beta',  doc: sampleDoc(1) });
    const list = listProjects();
    ok('two projects listed', list.length === 2);
    const names = list.map((p) => p.name).sort();
    ok('names roundtripped', names[0] === 'Alpha' && names[1] === 'Beta');
    const full = loadProject(a.id);
    ok('loadProject returns full doc', full.doc.components.length === 3);
    ok('metadata carries componentCount', list.find((p) => p.id === b.id).componentCount === 1);
}

console.log('updatedAt sort order:');
reset();
{
    const a = saveProject({ name: 'First',  doc: sampleDoc() });
    // Force a newer timestamp on b. We cheat by setting createdAt
    // back but relying on Date.now() monotonicity is usually enough.
    const b = saveProject({ name: 'Second', doc: sampleDoc() });
    const list = listProjects();
    ok('newest first', list[0].id === b.id || list[0].updatedAt >= list[1].updatedAt);
}

console.log('rename / duplicate / delete:');
reset();
{
    const a = saveProject({ name: 'Foo', doc: sampleDoc() });
    renameProject(a.id, 'FooBar');
    ok('rename sticks',   loadProject(a.id).name === 'FooBar');
    const dup = duplicateProject(a.id);
    ok('duplicate mints new id', dup.id !== a.id);
    ok('duplicate name auto-suffixed', /copy/i.test(dup.name));
    ok('duplicate has same component count',
        dup.doc.components.length === loadProject(a.id).doc.components.length);
    deleteProject(dup.id);
    ok('delete removes from list', listProjects().find((p) => p.id === dup.id) == null);
    ok('delete wipes blob', loadProject(dup.id) === null);
}

console.log('currentProjectId tracking:');
reset();
{
    const a = saveProject({ name: 'Active', doc: sampleDoc() });
    setCurrentProjectId(a.id);
    ok('current matches', getCurrentProjectId() === a.id);
    deleteProject(a.id);
    ok('delete of active clears pointer', getCurrentProjectId() == null);
}

console.log('legacy migration:');
reset();
{
    localStorage.setItem('circuitStudio:doc', JSON.stringify(sampleDoc(4)));
    const migrated = migrateLegacySingleSlot();
    ok('migration produces a project', migrated != null);
    ok('migrated name is friendly', migrated.name === 'Recovered design');
    ok('migrated currentProjectId set', getCurrentProjectId() === migrated.id);
    // Idempotent: second call should do nothing.
    const again = migrateLegacySingleSlot();
    ok('migration is idempotent', again == null);
}

console.log('loadInitialProject picks current first:');
reset();
{
    const a = saveProject({ name: 'A', doc: sampleDoc() });
    const b = saveProject({ name: 'B', doc: sampleDoc() });
    setCurrentProjectId(a.id);
    const chosen = loadInitialProject();
    ok('returns the current slot', chosen.id === a.id);
    // If current is deleted, falls back to newest.
    deleteProject(a.id);
    const chosen2 = loadInitialProject();
    ok('falls back to newest when current missing', chosen2.id === b.id);
}

console.log('importProjectJson (wrapped + flat):');
reset();
{
    const saved = saveProject({ name: 'Source', doc: sampleDoc(2) });
    const env = toExportEnvelope(saved);
    reset();
    const imported = importProjectJson(env);
    ok('wrapped envelope round-trips', imported.doc.components.length === 2);
    ok('imported name preserved', imported.name === 'Source');
    const flat = { name: 'Flat', doc: sampleDoc(1) };
    const imported2 = importProjectJson(flat);
    ok('flat form also accepted', imported2.doc.components.length === 1);
    let threw = false;
    try { importProjectJson({ foo: 'bar' }); } catch { threw = true; }
    ok('rejects junk JSON', threw);
}

console.log('uniqueName + formatUpdatedAt:');
reset();
{
    saveProject({ name: 'Draft', doc: sampleDoc() });
    saveProject({ name: 'Draft (2)', doc: sampleDoc() });
    const n = uniqueName('Draft');
    ok('picks next free slot', n === 'Draft (3)');
    const now = Date.now();
    ok('just now', formatUpdatedAt(now - 2000, now) === 'just now');
    ok('min ago',  /min ago$/.test(formatUpdatedAt(now - 5 * 60_000, now)));
    ok('hr ago',   /hr ago$/.test(formatUpdatedAt(now - 5 * 60 * 60_000, now)));
}

if (failed) { console.log(`\n✗ ${failed} assertion(s) failed`); process.exit(1); }
else console.log('\n✓ all project-storage assertions passed');
