import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

const BRIDGE_SCRIPT_SRC = '/api/plugins/baibaoku/v1/early/bridge.js';
const BEGIN_MARKER = '<!-- baibaoku early bridge:start -->';
const END_MARKER = '<!-- baibaoku early bridge:end -->';
const BRIDGE_BLOCK_PATTERN = new RegExp(
    String.raw`[ \t]*${escapeRegExp(BEGIN_MARKER)}[\s\S]*?${escapeRegExp(END_MARKER)}[ \t]*(?:\r?\n)?`,
    'g',
);

export function installEarlyBridge() {
    const indexPath = getIndexHtmlPath();

    try {
        const originalHtml = fs.readFileSync(indexPath, 'utf8');
        const patchedHtml = patchIndexHtml(originalHtml);

        if (patchedHtml === originalHtml) {
            console.log('[baibaoku] Early bridge is already installed in public/index.html.');
            return { changed: false, path: indexPath };
        }

        writeFileAtomicSync(indexPath, patchedHtml, 'utf8');
        console.log('[baibaoku] Installed early bridge into public/index.html.');

        return { changed: true, path: indexPath };
    } catch (error) {
        console.warn('[baibaoku] Failed to install early bridge into public/index.html:', error.message);
        return { changed: false, path: indexPath, error };
    }
}

export function patchIndexHtml(html) {
    const newline = html.includes('\r\n') ? '\r\n' : '\n';
    const bridgeBlock = [
        '    ' + BEGIN_MARKER,
        `    <script src="${BRIDGE_SCRIPT_SRC}"></script>`,
        '    ' + END_MARKER,
    ].join(newline) + newline;
    const cleanedHtml = html.replace(BRIDGE_BLOCK_PATTERN, '');

    if (hasUnmarkedBridgeScript(cleanedHtml)) {
        return cleanedHtml;
    }

    const headCloseMatch = cleanedHtml.match(/^[ \t]*<\/head\s*>/im);
    if (headCloseMatch?.index !== undefined) {
        return insertAt(cleanedHtml, headCloseMatch.index, bridgeBlock);
    }

    const firstScriptMatch = cleanedHtml.match(/^[ \t]*<script\b/im);
    if (firstScriptMatch?.index !== undefined) {
        return insertAt(cleanedHtml, firstScriptMatch.index, bridgeBlock);
    }

    const bodyCloseMatch = cleanedHtml.match(/^[ \t]*<\/body\s*>/im);
    if (bodyCloseMatch?.index !== undefined) {
        return insertAt(cleanedHtml, bodyCloseMatch.index, bridgeBlock);
    }

    return cleanedHtml.endsWith(newline)
        ? cleanedHtml + bridgeBlock
        : cleanedHtml + newline + bridgeBlock;
}

function getIndexHtmlPath() {
    const pluginDir = path.dirname(fileURLToPath(import.meta.url));
    const sillyTavernRoot = path.resolve(pluginDir, '..', '..', '..');

    return path.join(sillyTavernRoot, 'public', 'index.html');
}

function hasUnmarkedBridgeScript(html) {
    const quotedSrc = BRIDGE_SCRIPT_SRC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const scriptPattern = new RegExp(String.raw`<script\b[^>]*\bsrc=["']${quotedSrc}["'][^>]*>\s*</script>`, 'i');

    return scriptPattern.test(html);
}

function insertAt(text, index, insertion) {
    return text.slice(0, index) + insertion + text.slice(index);
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
