import { fileBasename } from './workspaceFilename.js';

/** Prism / refractor grammar id for syntax highlighting */
export function prismLanguageFromFileName(fileName) {
    const b = fileBasename(fileName).toLowerCase();
    const dot = b.lastIndexOf('.');
    const ext = dot >= 0 ? b.slice(dot + 1) : '';
    switch (ext) {
        case 'py':
        case 'pyw':
            return 'python';
        case 'js':
        case 'mjs':
        case 'cjs':
            return 'javascript';
        case 'jsx':
            return 'jsx';
        case 'ts':
            return 'typescript';
        case 'tsx':
            return 'tsx';
        case 'json':
        case 'ipynb':
            return 'json';
        case 'css':
            return 'css';
        case 'scss':
        case 'sass':
            return 'scss';
        case 'less':
            return 'less';
        case 'html':
        case 'htm':
        case 'vue':
        case 'svelte':
            return 'markup';
        case 'xml':
            return 'markup';
        case 'md':
        case 'markdown':
        case 'mdown':
        case 'mkd':
            return 'markdown';
        case 'yaml':
        case 'yml':
            return 'yaml';
        case 'toml':
            return 'toml';
        case 'sh':
        case 'bash':
        case 'zsh':
            return 'bash';
        case 'ps1':
            return 'powershell';
        case 'sql':
            return 'sql';
        case 'rs':
            return 'rust';
        case 'go':
            return 'go';
        case 'java':
            return 'java';
        case 'kt':
        case 'kts':
            return 'kotlin';
        case 'swift':
            return 'swift';
        case 'cpp':
        case 'cc':
        case 'cxx':
        case 'hpp':
            return 'cpp';
        case 'c':
        case 'h':
            return 'c';
        case 'cs':
            return 'csharp';
        case 'php':
            return 'php';
        case 'rb':
            return 'ruby';
        case 'r':
            return 'r';
        case 'dockerfile':
            return 'docker';
        case 'graphql':
        case 'gql':
            return 'graphql';
        case 'lua':
            return 'lua';
        case 'pl':
        case 'pm':
            return 'perl';
        case 'ex':
        case 'exs':
            return 'elixir';
        case 'scala':
        case 'sc':
            return 'scala';
        case 'jl':
            return 'julia';
        case 'vim':
            return 'vim';
        case 'nginx':
            return 'nginx';
        case 'ini':
        case 'cfg':
            return 'ini';
        default:
            return null;
    }
}

/**
 * How the file viewer should render this workspace file.
 */
export function classifyWorkspaceFileViewer(fileName) {
    const b = fileBasename(fileName).toLowerCase();
    if (!b) return { mode: 'unsupported' };
    if (/\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(b)) return { mode: 'image' };
    if (/\.pdf$/i.test(b)) return { mode: 'pdf' };
    if (/\.docx$/i.test(b)) return { mode: 'docx' };
    if (/\.doc$/i.test(b)) return { mode: 'doc-legacy' };
    if (/\.(xlsx|xls)$/i.test(b)) return { mode: 'excel-binary' };
    if (/\.(csv|tsv)$/i.test(b)) return { mode: 'csv-text' };
    const language = prismLanguageFromFileName(fileName);
    if (language) return { mode: 'code', language };
    if (b === '.env' || /\.env$/i.test(b)) return { mode: 'plain-text' };
    if (/\.(txt|log|gitignore|editorconfig|rtf)$/i.test(b)) return { mode: 'plain-text' };
    return { mode: 'unsupported' };
}
