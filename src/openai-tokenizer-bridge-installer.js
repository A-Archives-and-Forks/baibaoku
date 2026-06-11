import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

const BEGIN_MARKER = '// baibaoku tokenizer bridge:start';
const END_MARKER = '// baibaoku tokenizer bridge:end';
const BRIDGE_BLOCK_PATTERN = new RegExp(
    String.raw`[ \t]*${escapeRegExp(BEGIN_MARKER)}[\s\S]*?${escapeRegExp(END_MARKER)}[ \t]*(?:\r?\n)?`,
    'g',
);

export function installOpenAITokenizerBridge() {
    const openaiPath = getOpenAIPath();

    try {
        const originalSource = fs.readFileSync(openaiPath, 'utf8');
        const patchedSource = patchOpenAIJs(originalSource);

        if (patchedSource === originalSource) {
            if (hasOpenAITokenizerBridge(originalSource)) {
                console.log('[baibaoku] OpenAI tokenizer bridge is already installed in public/scripts/openai.js.');
            } else {
                console.warn('[baibaoku] OpenAI tokenizer bridge was not installed: public/scripts/openai.js did not match known anchors.');
            }
            return { changed: false, path: openaiPath };
        }

        writeFileAtomicSync(openaiPath, patchedSource, 'utf8');
        console.log('[baibaoku] Installed OpenAI tokenizer bridge into public/scripts/openai.js.');

        return { changed: true, path: openaiPath };
    } catch (error) {
        console.warn('[baibaoku] Failed to install OpenAI tokenizer bridge into public/scripts/openai.js:', error.message);
        return { changed: false, path: openaiPath, error };
    }
}

export function patchOpenAIJs(source) {
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const cleanedSource = source.replace(BRIDGE_BLOCK_PATTERN, '');
    const anchor = `${newline}        // Fill the chat completion with as much context as the budget allows`;

    if (!cleanedSource.includes('export async function prepareOpenAIMessages')
        || !cleanedSource.includes('const prompts = await preparePromptsForChatCompletion({')
        || !cleanedSource.includes(anchor.trim())) {
        return cleanedSource;
    }

    const bridgeBlock = [
        `        ${BEGIN_MARKER}`,
        '        await Promise.resolve(globalThis.__baibaokuTokenizerBulkBridge?.prepareOpenAIMessages?.({',
        '            version: 1,',
        '            dryRun,',
        '            prompts,',
        '            promptManager,',
        '            oaiSettings: oai_settings,',
        '            selectedGroup: selected_group,',
        '            bias,',
        '            quietPrompt,',
        '            quietImage,',
        '            type,',
        '            cyclePrompt,',
        '            messages,',
        '            messageExamples,',
        '            newChatContent: substituteParams(selected_group ? oai_settings.new_group_chat_prompt : oai_settings.new_chat_prompt),',
        '            sendIfEmpty: oai_settings.send_if_empty,',
        '            newExampleChatContent: substituteParams(oai_settings.new_example_chat_prompt),',
        "        })).catch(error => console.debug('[baibaoku] OpenAI tokenizer bridge prepare failed', error));",
        `        ${END_MARKER}`,
    ].join(newline) + newline;

    return cleanedSource.replace(anchor, `${newline}${bridgeBlock}        // Fill the chat completion with as much context as the budget allows`);
}

function getOpenAIPath() {
    const pluginDir = path.dirname(fileURLToPath(import.meta.url));
    const sillyTavernRoot = path.resolve(pluginDir, '..', '..', '..');

    return path.join(sillyTavernRoot, 'public', 'scripts', 'openai.js');
}

function hasOpenAITokenizerBridge(source) {
    return source.includes(BEGIN_MARKER) && source.includes(END_MARKER);
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
