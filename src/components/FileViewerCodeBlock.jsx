import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker';
import elixir from 'react-syntax-highlighter/dist/esm/languages/prism/elixir';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import graphql from 'react-syntax-highlighter/dist/esm/languages/prism/graphql';
import ini from 'react-syntax-highlighter/dist/esm/languages/prism/ini';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import julia from 'react-syntax-highlighter/dist/esm/languages/prism/julia';
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin';
import less from 'react-syntax-highlighter/dist/esm/languages/prism/less';
import lua from 'react-syntax-highlighter/dist/esm/languages/prism/lua';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import nginx from 'react-syntax-highlighter/dist/esm/languages/prism/nginx';
import perl from 'react-syntax-highlighter/dist/esm/languages/prism/perl';
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php';
import powershell from 'react-syntax-highlighter/dist/esm/languages/prism/powershell';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import r from 'react-syntax-highlighter/dist/esm/languages/prism/r';
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import scala from 'react-syntax-highlighter/dist/esm/languages/prism/scala';
import scss from 'react-syntax-highlighter/dist/esm/languages/prism/scss';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift';
import toml from 'react-syntax-highlighter/dist/esm/languages/prism/toml';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import vim from 'react-syntax-highlighter/dist/esm/languages/prism/vim';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';

const pairs = [
    ['python', python],
    ['javascript', javascript],
    ['jsx', jsx],
    ['typescript', typescript],
    ['tsx', tsx],
    ['json', json],
    ['css', css],
    ['scss', scss],
    ['less', less],
    ['markup', markup],
    ['markdown', markdown],
    ['yaml', yaml],
    ['toml', toml],
    ['bash', bash],
    ['powershell', powershell],
    ['sql', sql],
    ['rust', rust],
    ['go', go],
    ['java', java],
    ['kotlin', kotlin],
    ['swift', swift],
    ['cpp', cpp],
    ['c', c],
    ['csharp', csharp],
    ['php', php],
    ['ruby', ruby],
    ['r', r],
    ['docker', docker],
    ['graphql', graphql],
    ['lua', lua],
    ['perl', perl],
    ['elixir', elixir],
    ['scala', scala],
    ['julia', julia],
    ['vim', vim],
    ['nginx', nginx],
    ['ini', ini],
];

for (const [name, lang] of pairs) {
    SyntaxHighlighter.registerLanguage(name, lang);
}

/**
 * Syntax-highlighted code (Prism / VS Code–style dark theme).
 */
export default function FileViewerCodeBlock({ code, language, showLineNumbers = true }) {
    if (code == null) return null;
    const text = String(code);
    return (
        <SyntaxHighlighter
            language={language}
            style={vscDarkPlus}
            showLineNumbers={showLineNumbers}
            wrapLines
            wrapLongLines
            customStyle={{
                margin: 0,
                borderRadius: 10,
                maxHeight: '100%',
                fontSize: 13,
                lineHeight: 1.5,
            }}
            codeTagProps={{
                style: {
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                },
            }}
        >
            {text}
        </SyntaxHighlighter>
    );
}
