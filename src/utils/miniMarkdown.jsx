/**
 * Tiny in-house Markdown → React renderer.
 *
 * Why not pull in `react-markdown`? The HSP Studio tutorial is the only
 * place we render Markdown right now, and `react-markdown` + remark adds
 * ~60 kB to the bundle. This file handles the subset our docs actually
 * use: headings (h1–h4), paragraphs, fenced code blocks, inline code,
 * **bold** / *italic*, `[links](url)`, unordered and ordered lists,
 * GitHub-style tables, blockquotes, and `---` horizontal rules.
 *
 * The parser is intentionally line-by-line and does NOT try to be a
 * spec-correct CommonMark implementation — it's good enough for our
 * own authored documents but should not be used for untrusted Markdown
 * (security: we escape HTML, but edge cases in arbitrary user input
 * can still produce surprising output).
 */

import React from 'react';

/* ============================================================
 * Inline formatting
 * ============================================================ */

/**
 * Render an inline text run with **bold**, *italic*, `code`, and
 * [link](url) support. Escapes any raw HTML in the source.
 *
 * The tokens are deliberately greedy in a simple way: we scan left to
 * right, slicing off the next-matching marker. Works fine for any
 * well-formed Markdown our docs produce.
 */
function renderInline(text, keyPrefix = 'i') {
    if (!text) return null;
    const out = [];
    let buf = '';
    let i = 0;
    let n = 0;
    const flush = () => {
        if (buf) {
            out.push(buf);
            buf = '';
        }
    };
    while (i < text.length) {
        const ch = text[i];
        /* inline code */
        if (ch === '`') {
            const close = text.indexOf('`', i + 1);
            if (close > i) {
                flush();
                out.push(
                    <code key={`${keyPrefix}-c-${n++}`} className="mm-code">
                        {text.slice(i + 1, close)}
                    </code>
                );
                i = close + 1;
                continue;
            }
        }
        /* link [text](url) */
        if (ch === '[') {
            const closeBr = text.indexOf(']', i + 1);
            if (closeBr > i && text[closeBr + 1] === '(') {
                const closeParen = text.indexOf(')', closeBr + 2);
                if (closeParen > closeBr + 1) {
                    flush();
                    const label = text.slice(i + 1, closeBr);
                    const url = text.slice(closeBr + 2, closeParen);
                    out.push(
                        <a
                            key={`${keyPrefix}-l-${n++}`}
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mm-link"
                        >
                            {label}
                        </a>
                    );
                    i = closeParen + 1;
                    continue;
                }
            }
        }
        /* bold **text** */
        if (ch === '*' && text[i + 1] === '*') {
            const close = text.indexOf('**', i + 2);
            if (close > i + 1) {
                flush();
                out.push(
                    <strong key={`${keyPrefix}-b-${n++}`}>
                        {renderInline(text.slice(i + 2, close), `${keyPrefix}-bb-${n}`)}
                    </strong>
                );
                i = close + 2;
                continue;
            }
        }
        /* italic *text* — must NOT eat list bullets at start of line, but
           inside a run we only see post-bullet content already, so just
           check it's surrounded by non-spaces / is plausibly inline. */
        if (ch === '*' && text[i + 1] !== '*' && text[i + 1] !== ' ' && text[i - 1] !== '\\') {
            const close = text.indexOf('*', i + 1);
            if (close > i && text[close - 1] !== ' ') {
                flush();
                out.push(
                    <em key={`${keyPrefix}-i-${n++}`}>
                        {renderInline(text.slice(i + 1, close), `${keyPrefix}-ii-${n}`)}
                    </em>
                );
                i = close + 1;
                continue;
            }
        }
        buf += ch;
        i++;
    }
    flush();
    return out;
}

/* ============================================================
 * Block parser
 * ============================================================ */

/**
 * Parse a Markdown string into an array of React block elements.
 * Public entry point. Returns a single fragment-friendly array.
 */
export function renderMarkdown(src) {
    if (!src) return null;
    const lines = src.replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    let i = 0;
    let key = 0;

    const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);

    while (i < lines.length) {
        const raw = lines[i];
        const line = raw ?? '';
        const trimmed = line.trim();

        /* horizontal rule */
        if (/^---+$/.test(trimmed)) {
            blocks.push(<hr key={`hr-${key++}`} className="mm-hr" />);
            i++;
            continue;
        }

        /* blank line */
        if (trimmed === '') { i++; continue; }

        /* fenced code block ``` */
        if (trimmed.startsWith('```')) {
            const langSpec = trimmed.slice(3).trim();
            const codeLines = [];
            i++;
            while (i < lines.length && !lines[i].trim().startsWith('```')) {
                codeLines.push(lines[i]);
                i++;
            }
            if (i < lines.length) i++; /* skip closing fence */
            blocks.push(
                <pre key={`code-${key++}`} className="mm-pre">
                    <code className={langSpec ? `mm-lang-${langSpec}` : ''}>
                        {codeLines.join('\n')}
                    </code>
                </pre>
            );
            continue;
        }

        /* heading */
        const hMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
        if (hMatch) {
            const level = hMatch[1].length;
            const text = hMatch[2];
            const Tag = `h${Math.min(level, 6)}`;
            blocks.push(
                React.createElement(
                    Tag,
                    { key: `h-${key++}`, className: `mm-h mm-h${level}` },
                    renderInline(text, `h${key}`)
                )
            );
            i++;
            continue;
        }

        /* blockquote */
        if (trimmed.startsWith('>')) {
            const qLines = [];
            while (i < lines.length && lines[i].trim().startsWith('>')) {
                qLines.push(lines[i].replace(/^\s*>\s?/, ''));
                i++;
            }
            blocks.push(
                <blockquote key={`bq-${key++}`} className="mm-bq">
                    {qLines.map((l, idx) => (
                        <p key={idx} className="mm-p">{renderInline(l, `bq${key}-${idx}`)}</p>
                    ))}
                </blockquote>
            );
            continue;
        }

        /* table */
        if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
            const header = parseTableRow(line);
            i += 2; /* skip header + separator */
            const rows = [];
            while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim() !== '') {
                rows.push(parseTableRow(lines[i]));
                i++;
            }
            blocks.push(
                <div key={`tbl-${key++}`} className="mm-table-wrap">
                    <table className="mm-table">
                        <thead>
                            <tr>{header.map((c, ci) => (
                                <th key={ci}>{renderInline(c, `th-${ci}`)}</th>
                            ))}</tr>
                        </thead>
                        <tbody>
                            {rows.map((r, ri) => (
                                <tr key={ri}>
                                    {r.map((c, ci) => (
                                        <td key={ci}>{renderInline(c, `td-${ri}-${ci}`)}</td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            );
            continue;
        }

        /* ordered list */
        if (/^\s*\d+\.\s+/.test(line)) {
            const items = [];
            while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
                items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
                i++;
                /* Allow continuation lines (paragraph wrap inside an item)
                   until the next bullet or blank line. */
                while (
                    i < lines.length
                    && lines[i].trim() !== ''
                    && !/^\s*\d+\.\s+/.test(lines[i])
                    && !/^\s*[-*]\s+/.test(lines[i])
                    && !/^#{1,6}\s+/.test(lines[i].trim())
                ) {
                    items[items.length - 1] += ' ' + lines[i].trim();
                    i++;
                }
            }
            blocks.push(
                <ol key={`ol-${key++}`} className="mm-ol">
                    {items.map((line, idx) => (
                        <li key={idx} className="mm-li">{renderInline(line, `ol${key}-${idx}`)}</li>
                    ))}
                </ol>
            );
            continue;
        }

        /* unordered list */
        if (/^\s*[-*]\s+/.test(line)) {
            const items = [];
            while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
                items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
                i++;
                while (
                    i < lines.length
                    && lines[i].trim() !== ''
                    && !/^\s*[-*]\s+/.test(lines[i])
                    && !/^\s*\d+\.\s+/.test(lines[i])
                    && !/^#{1,6}\s+/.test(lines[i].trim())
                ) {
                    items[items.length - 1] += ' ' + lines[i].trim();
                    i++;
                }
            }
            blocks.push(
                <ul key={`ul-${key++}`} className="mm-ul">
                    {items.map((line, idx) => (
                        <li key={idx} className="mm-li">{renderInline(line, `ul${key}-${idx}`)}</li>
                    ))}
                </ul>
            );
            continue;
        }

        /* paragraph (collect contiguous non-blank lines) */
        const pLines = [];
        while (
            i < lines.length
            && lines[i].trim() !== ''
            && !/^#{1,6}\s+/.test(lines[i].trim())
            && !lines[i].trim().startsWith('```')
            && !lines[i].trim().startsWith('>')
            && !/^---+$/.test(lines[i].trim())
            && !/^\s*[-*]\s+/.test(lines[i])
            && !/^\s*\d+\.\s+/.test(lines[i])
            && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))
        ) {
            pLines.push(lines[i]);
            i++;
        }
        if (pLines.length > 0) {
            blocks.push(
                <p key={`p-${key++}`} className="mm-p">
                    {renderInline(pLines.join(' '), `p${key}`)}
                </p>
            );
            continue;
        }

        /* fallback: render the line raw to avoid infinite loops on
           something the parser didn't recognise */
        blocks.push(<p key={`raw-${key++}`} className="mm-p">{renderInline(line, `raw${key}`)}</p>);
        i++;
    }

    return blocks;
}

function parseTableRow(line) {
    const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return trimmed.split('|').map((c) => c.trim());
}
