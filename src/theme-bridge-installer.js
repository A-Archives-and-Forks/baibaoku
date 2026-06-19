import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

const BEGIN_MARKER = '// baibaoku theme bridge:start';
const END_MARKER = '// baibaoku theme bridge:end';
const BRIDGE_BLOCK_PATTERN = new RegExp(
    String.raw`(?:\r?\n)*[ \t]*${escapeRegExp(BEGIN_MARKER)}[\s\S]*?${escapeRegExp(END_MARKER)}`,
    'g',
);

// Anchor on the closing line of applyTheme(). This text is identical across all
// known ST versions (the function body differs, but this trailing log + brace do not).
const ANCHOR = "    console.log('theme applied: ' + name);\n}";
const ANCHOR_CRLF = "    console.log('theme applied: ' + name);\r\n}";

export function installThemeBridge() {
    const powerUserPath = getPowerUserPath();

    try {
        const originalSource = fs.readFileSync(powerUserPath, 'utf8');
        const patchedSource = patchPowerUserJs(originalSource);

        if (patchedSource === originalSource) {
            if (hasThemeBridge(originalSource)) {
                console.log('[baibaoku] Theme bridge is already installed in public/scripts/power-user.js.');
            } else {
                console.warn('[baibaoku] Theme bridge was not installed: public/scripts/power-user.js did not match known anchors.');
            }
            return { changed: false, path: powerUserPath };
        }

        writeFileAtomicSync(powerUserPath, patchedSource, 'utf8');
        console.log('[baibaoku] Installed theme bridge into public/scripts/power-user.js.');

        return { changed: true, path: powerUserPath };
    } catch (error) {
        console.warn('[baibaoku] Failed to install theme bridge into public/scripts/power-user.js:', error.message);
        return { changed: false, path: powerUserPath, error };
    }
}

export function patchPowerUserJs(source) {
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const cleanedSource = source.replace(BRIDGE_BLOCK_PATTERN, '');

    const anchor = newline === '\r\n' ? ANCHOR_CRLF : ANCHOR;
    if (!cleanedSource.includes(anchor)) {
        return cleanedSource;
    }

    const bridgeBlock = [
        '',
        '',
        BEGIN_MARKER,
        '// Expose native theme application + a hydrator for the module-scoped `themes`',
        '// array so the baibaoku lazy-theme loader can delegate to the native applyTheme,',
        '// keeping lazy switching on the exact same code path as a normal switch.',
        'if (typeof window !== \'undefined\') {',
        '    window.baibaokuApplyNativeTheme = applyTheme;',
        '    window.baibaokuHydrateTheme = function (t) {',
        '        if (!t || typeof t.name !== \'string\' || !t.name) return;',
        '        const i = themes.findIndex(x => x.name === t.name);',
        '        if (i === -1) themes.push(t); else themes[i] = t;',
        '    };',
        '}',
        END_MARKER,
    ].join(newline);

    // Insert the bridge block immediately after applyTheme()'s closing brace.
    return cleanedSource.replace(anchor, `${anchor}${bridgeBlock}`);
}

function getPowerUserPath() {
    const pluginDir = path.dirname(fileURLToPath(import.meta.url));
    const sillyTavernRoot = path.resolve(pluginDir, '..', '..', '..');

    return path.join(sillyTavernRoot, 'public', 'scripts', 'power-user.js');
}

function hasThemeBridge(source) {
    return source.includes(BEGIN_MARKER) && source.includes(END_MARKER);
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
