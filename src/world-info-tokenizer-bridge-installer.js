import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

const BEGIN_MARKER = '// baibaoku world info tokenizer bridge:start';
const END_MARKER = '// baibaoku world info tokenizer bridge:end';
const BRIDGE_BLOCK_PATTERN = new RegExp(
    String.raw`[ \t]*${escapeRegExp(BEGIN_MARKER)}[\s\S]*?${escapeRegExp(END_MARKER)}[ \t]*(?:\r?\n)?`,
    'g',
);

export function installWorldInfoTokenizerBridge() {
    const worldInfoPath = getWorldInfoPath();

    try {
        const originalSource = fs.readFileSync(worldInfoPath, 'utf8');
        const patchedSource = patchWorldInfoJs(originalSource);

        if (patchedSource === originalSource) {
            if (hasWorldInfoTokenizerBridge(originalSource)) {
                console.log('[baibaoku] World Info tokenizer bridge is already installed in public/scripts/world-info.js.');
            } else {
                console.warn('[baibaoku] World Info tokenizer bridge was not installed: public/scripts/world-info.js did not match known anchors.');
            }
            return { changed: false, path: worldInfoPath };
        }

        writeFileAtomicSync(worldInfoPath, patchedSource, 'utf8');
        console.log('[baibaoku] Installed World Info tokenizer bridge into public/scripts/world-info.js.');

        return { changed: true, path: worldInfoPath };
    } catch (error) {
        console.warn('[baibaoku] Failed to install World Info tokenizer bridge into public/scripts/world-info.js:', error.message);
        return { changed: false, path: worldInfoPath, error };
    }
}

export function patchWorldInfoJs(source) {
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const cleanedSource = source.replace(BRIDGE_BLOCK_PATTERN, '');
    const originalAnchor = [
        '        let newContent = \'\';',
        '        const textToScanTokens = await getTokenCountAsync(allActivatedText);',
        '',
        '        filterByInclusionGroups(newEntries, allActivatedEntries, buffer, scanState, timedEffects);',
    ].join(newline);
    const reentrantAnchor = [
        '        let newContent = \'\';',
        '',
        '        filterByInclusionGroups(newEntries, allActivatedEntries, buffer, scanState, timedEffects);',
        '',
        '        const textToScanTokens = await getTokenCountAsync(allActivatedText);',
    ].join(newline);
    const anchor = cleanedSource.includes(originalAnchor)
        ? originalAnchor
        : cleanedSource.includes(reentrantAnchor)
            ? reentrantAnchor
            : '';

    if (!cleanedSource.includes('export async function getWorldInfoPrompt')
        || !cleanedSource.includes('async function checkWorldInfo')
        || !anchor) {
        return hasWorldInfoTokenizerBridge(source) ? source : cleanedSource;
    }

    const replacement = [
        '        let newContent = \'\';',
        '',
        '        filterByInclusionGroups(newEntries, allActivatedEntries, buffer, scanState, timedEffects);',
        '',
        `        ${BEGIN_MARKER}`,
        '        const baibaokuWorldInfoBudgetContent = new WeakMap();',
        '        const baibaokuWorldInfoTokenizerBridge = globalThis.__baibaokuTokenizerBulkBridge;',
        '        if (typeof baibaokuWorldInfoTokenizerBridge?.prepareWorldInfoBudgetCounts === \'function\'',
        '            && baibaokuWorldInfoTokenizerBridge?.isEnabled?.() !== false) {',
        '            await Promise.resolve(baibaokuWorldInfoTokenizerBridge.prepareWorldInfoBudgetCounts({',
        '                version: 1,',
        '                textToScan: allActivatedText,',
        '                entries: newEntries.map(entry => {',
        '                    const content = substituteParams(entry?.content ?? \'\');',
        '                    baibaokuWorldInfoBudgetContent.set(entry, content);',
        '                    return {',
        '                        content,',
        '                        ignoreBudget: Boolean(entry?.ignoreBudget),',
        '                        maySkip: Boolean(entry?.useProbability && entry?.probability !== 100 && !timedEffects.isEffectActive(\'sticky\', entry)),',
        '                    };',
        '                }),',
        "            })).catch(error => console.debug('[baibaoku] World Info tokenizer bridge prepare failed', error));",
        '        }',
        `        ${END_MARKER}`,
        '        const textToScanTokens = await getTokenCountAsync(allActivatedText);',
    ].join(newline);

    return cleanedSource
        .replace(anchor, replacement)
        .replace(
            '            entry.content = substituteParams(entry.content);',
            '            entry.content = baibaokuWorldInfoBudgetContent.get(entry) ?? substituteParams(entry.content);',
        );
}

function getWorldInfoPath() {
    const pluginDir = path.dirname(fileURLToPath(import.meta.url));
    const sillyTavernRoot = path.resolve(pluginDir, '..', '..', '..');

    return path.join(sillyTavernRoot, 'public', 'scripts', 'world-info.js');
}

function hasWorldInfoTokenizerBridge(source) {
    return source.includes(BEGIN_MARKER) && source.includes(END_MARKER);
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
