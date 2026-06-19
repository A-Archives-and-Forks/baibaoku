import { registerApi } from './src/api.js';
import { PLUGIN_ID, PLUGIN_NAME } from './src/constants.js';
import { DatabaseManager } from './src/database.js';
import { installEarlyBridge } from './src/early-bridge-installer.js';
import { installOpenAITokenizerBridge } from './src/openai-tokenizer-bridge-installer.js';
import { installThemeBridge } from './src/theme-bridge-installer.js';
import { closeStEndpointCaches } from './src/st-endpoints.js';

export const info = {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: 'A universal per-user KV storage server plugin for SillyTavern extensions.',
};

const manager = new DatabaseManager();

export async function init(router) {
    registerApi(router, manager);
    installEarlyBridge();
    installOpenAITokenizerBridge();
    installThemeBridge();
}

export async function exit() {
    closeStEndpointCaches();
    manager.closeAll();
}
