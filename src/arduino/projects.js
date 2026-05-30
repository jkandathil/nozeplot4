/**
 * Project model for the Arduino & ESP32 programmer.
 *
 * A *project* is a multi-file sketch (a "large-scale app"): one main `.ino`
 * plus any number of `.cpp` / `.h` files, and a list of external libraries
 * (forwarded to the remote compile server for `arduino-cli lib install`).
 *
 * Projects persist in localStorage; v1 single-file storage is migrated on load.
 */

const LS_PROJECTS = 'arduino:projects:v2';
const LS_ACTIVE_PROJECT = 'arduino:active-project';
const LS_FILES_V1 = 'arduino:files:v1';

export const SKETCH_EXT_RE = /\.(ino|pde|cpp|cc|cxx|c|hpp|hh|h)$/i;

export const DEFAULT_SKETCH = `// Blink — works on Uno/Nano (LED_BUILTIN) and most ESP32 boards.
#ifndef LED_BUILTIN
#define LED_BUILTIN 2  // common ESP32 onboard LED
#endif

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.println("NozePlot MCU: hello!");
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
  Serial.println("blink");
}
`;

let counter = 0;
export function uid(prefix = 'id') {
    counter += 1;
    return `${prefix}_${Date.now().toString(36)}_${counter}_${Math.random().toString(36).slice(2, 7)}`;
}

export function isSketchFileName(name) {
    return SKETCH_EXT_RE.test(String(name || ''));
}

export function isMainCandidate(file) {
    if (!file) return false;
    if (/\.(ino|pde)$/i.test(file.name)) return true;
    return /\bvoid\s+setup\s*\(/.test(file.content || '') && /\bvoid\s+loop\s*\(/.test(file.content || '');
}

export function makeFile(name, content = '') {
    return { id: uid('file'), name: String(name || 'untitled.ino'), content: String(content) };
}

export function makeProject(name, files, libraries = []) {
    const fs = files && files.length ? files : [makeFile('main.ino', DEFAULT_SKETCH)];
    const main = fs.find(isMainCandidate) || fs[0];
    return {
        id: uid('proj'),
        name: String(name || 'sketch_project'),
        files: fs,
        mainFileId: main.id,
        libraries: Array.isArray(libraries) ? libraries.filter(Boolean) : [],
    };
}

export function getMainFile(project) {
    if (!project) return null;
    return project.files.find((f) => f.id === project.mainFileId) || project.files.find(isMainCandidate) || project.files[0] || null;
}

/** Extra (non-main) files as a { name: content } map for the compile server. */
export function extraFilesMap(project, excludeFileId) {
    if (!project) return {};
    const skipId = excludeFileId ?? getMainFile(project)?.id;
    const out = {};
    for (const f of project.files) {
        if (f.id === skipId) continue;
        out[f.name] = f.content;
    }
    return out;
}

/** Pick the .ino to compile: active editor tab if it is an .ino, else project main. */
export function getSketchFileForBuild(project, activeFileId) {
    if (!project) return null;
    const active = project.files.find((f) => f.id === activeFileId);
    if (active && /\.(ino|pde)$/i.test(active.name)) return active;
    return getMainFile(project);
}

export function loadProjects() {
    try {
        const raw = localStorage.getItem(LS_PROJECTS);
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr) && arr.length) return arr.map(normalizeProject);
        }
    } catch {
        /* ignore */
    }
    // migrate v1 flat files → one project
    try {
        const rawV1 = localStorage.getItem(LS_FILES_V1);
        if (rawV1) {
            const files = JSON.parse(rawV1);
            if (Array.isArray(files) && files.length) {
                const mapped = files.map((f) => makeFile(f.name || 'sketch.ino', f.content || ''));
                return [makeProject('My sketches', mapped)];
            }
        }
    } catch {
        /* ignore */
    }
    return [makeProject('Blink', [makeFile('blink.ino', DEFAULT_SKETCH)])];
}

function normalizeProject(p) {
    const files = Array.isArray(p.files) && p.files.length ? p.files.map((f) => ({
        id: f.id || uid('file'),
        name: f.name || 'untitled.ino',
        content: String(f.content || ''),
    })) : [makeFile('main.ino', DEFAULT_SKETCH)];
    const mainFileId = files.find((f) => f.id === p.mainFileId)?.id || (files.find(isMainCandidate) || files[0]).id;
    return {
        id: p.id || uid('proj'),
        name: p.name || 'project',
        files,
        mainFileId,
        libraries: Array.isArray(p.libraries) ? p.libraries.filter(Boolean) : [],
    };
}

export function persistProjects(projects) {
    try {
        localStorage.setItem(LS_PROJECTS, JSON.stringify(projects));
    } catch {
        /* ignore */
    }
}

export function loadActiveProjectId(projects) {
    try {
        const id = localStorage.getItem(LS_ACTIVE_PROJECT);
        if (id && projects.some((p) => p.id === id)) return id;
    } catch {
        /* ignore */
    }
    return projects[0]?.id;
}

export function persistActiveProjectId(id) {
    try {
        localStorage.setItem(LS_ACTIVE_PROJECT, id);
    } catch {
        /* ignore */
    }
}

/** Ensure a unique file name within a project (foo.h → foo_1.h). */
export function uniqueFileName(project, name) {
    const existing = new Set((project?.files || []).map((f) => f.name.toLowerCase()));
    if (!existing.has(name.toLowerCase())) return name;
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let i = 1;
    while (existing.has(`${base}_${i}${ext}`.toLowerCase())) i += 1;
    return `${base}_${i}${ext}`;
}
