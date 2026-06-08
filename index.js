import { registerApi } from './src/api.js';
import { PLUGIN_ID, PLUGIN_NAME } from './src/constants.js';
import { DatabaseManager } from './src/database.js';

export const info = {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: 'A universal per-user KV storage server plugin for SillyTavern extensions.',
};

const manager = new DatabaseManager();

export async function init(router) {
    registerApi(router, manager);
}

export async function exit() {
    manager.closeAll();
}
