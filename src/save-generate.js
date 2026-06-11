import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import _ from 'lodash';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { router as chatCompletionsRouter } from '../../../src/endpoints/backends/chat-completions.js';
import * as chatsEndpoint from '../../../src/endpoints/chats.js';
import { CHAT_COMPLETION_SOURCES } from '../../../src/constants.js';
import {
    generateTimestamp,
    getConfigValue,
    removeOldBackups,
    tryParse,
} from '../../../src/util.js';

const SAVE_GENERATE_JOB_TTL_MS = 30 * 60 * 1000;
const SAVE_GENERATE_MAX_JOBS = 200;
const SAVE_GENERATE_DEFAULT_ERROR_STATUS = 500;
const SAVE_GENERATE_CHAT_BACKUPS_PREFIX = 'chat_';

const saveGenerateChatBackupsEnabled = !!getConfigValue('backups.chat.enabled', true, 'boolean');
const saveGenerateChatBackupLimit = Number(getConfigValue('backups.chat.maxTotalBackups', -1, 'number'));
const saveGenerateChatBackupThrottleInterval = Number(getConfigValue('backups.chat.throttleInterval', 10_000, 'number'));
const saveGenerateChatIntegrityCheck = !!getConfigValue('backups.chat.checkIntegrity', true, 'boolean');

const saveGenerateJobs = new Map();
const saveGenerateLocks = new Map();
const saveGenerateBackupFunctions = new Map();

export function registerSaveGenerateEndpoints(router) {
    router.post('/v1/chats/save-generate', async (req, res) => {
        try {
            const job = createSaveGenerateJob(req);
            const isStream = job.generate.stream === true;
            res.set('X-Baibaoku-Save-Generate-Job-Id', job.id);

            if (isStream) {
                res.set('Cache-Control', 'no-cache');
                await runSaveGenerateJob(job, { streamResponse: res });
                return;
            }

            const result = await runSaveGenerateJob(job);
            sendCapturedGenerateResponse(res, result.response, job);
        } catch (error) {
            console.error('[baibaoku] Error in save-generate endpoint:', error);
            if (!res.headersSent && !res.writableEnded) {
                sendGenerateErrorResponse(res, error);
            } else if (!res.writableEnded) {
                res.end();
            }
        }
    });

    router.post('/v1/chats/save-generate/status', (req, res) => {
        try {
            res.json({
                ok: true,
                data: getSaveGenerateJobForRequest(req, req.body?.jobId || req.body?.id),
            });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.post('/v1/chats/save-generate/cancel', (req, res) => {
        try {
            res.json({
                ok: true,
                data: cancelSaveGenerateJobForRequest(
                    req,
                    req.body?.jobId || req.body?.id,
                    req.body?.chatId || req.body?.chat_id,
                ),
            });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.post('/v1/chats/save-generate/:jobId/cancel', (req, res) => {
        try {
            res.json({
                ok: true,
                data: cancelSaveGenerateJobForRequest(req, req.params?.jobId),
            });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.get('/v1/chats/save-generate/pending', async (req, res) => {
        try {
            res.json({
                ok: true,
                data: await findSaveGenerateJobForChat(
                    req,
                    req.query?.chatId || req.query?.chat_id,
                    req.query?.lastMessageHash || req.query?.last_message_hash,
                ),
            });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.get('/v1/chats/save-generate/:jobId', (req, res) => {
        try {
            res.json({
                ok: true,
                data: getSaveGenerateJobForRequest(req, req.params?.jobId),
            });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: true, message: error.message });
        }
    });
}

export function closeSaveGenerateJobs() {
    saveGenerateJobs.clear();
    saveGenerateLocks.clear();
}

function createSaveGenerateJob(req) {
    cleanupSaveGenerateJobs();

    const userHandle = req.user?.profile?.handle;
    if (!userHandle) {
        throwHttpError('Unauthorized', 401);
    }

    const save = req.body?.save;
    const generate = req.body?.generate;
    if (!save || typeof save !== 'object') {
        throwHttpError('save must be an object', 400);
    }
    if (!generate || typeof generate !== 'object') {
        throwHttpError('generate must be an object', 400);
    }

    validateSaveGenerateRequest(save, generate);

    const descriptor = resolveSaveGenerateChatFile(req, save);
    const id = crypto.randomUUID();
    const now = Date.now();
    const job = {
        id,
        userHandle,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
        generateStartedAt: null,
        generateFinishedAt: null,
        savedAt: null,
        error: null,
        resultText: '',
        reasoning: '',
        responseStatus: null,
        responseStatusText: '',
        cancelRequested: false,
        canceledAt: null,
        save: {
            kind: descriptor.kind,
            type: getSaveGenerateType(save, generate),
            chatId: normalizeChatId(save.chatId ?? save.chat_id ?? descriptor.fileName),
            avatar_url: descriptor.avatarUrl,
            file_name: descriptor.fileName,
            ch_name: descriptor.characterName,
            expectedVersion: normalizeExpectedVersion(save.expectedVersion ?? save.expected_version),
        },
        descriptor,
        generate: structuredClone(generate),
        savedMessage: null,
        savedMessageFloor: null,
        conflict: null,
        alreadySaved: false,
        generateRequestSocket: null,
        captureResponse: null,
    };

    saveGenerateJobs.set(id, job);
    cleanupSaveGenerateJobs();
    return job;
}

function validateSaveGenerateRequest(save, generate) {
    const kind = String(save.kind || 'character');
    if (kind !== 'character') {
        throwHttpError('Only single-character chats are supported by save-generate v1', 400);
    }

    const type = getSaveGenerateType(save, generate);
    if (!['normal', 'regenerate'].includes(type)) {
        throwHttpError('Only normal and regenerate assistant replies are supported by save-generate v1', 400);
    }

    if (!save.avatar_url || !save.file_name) {
        throwHttpError('save.avatar_url and save.file_name are required', 400);
    }

    if (generate.chat_completion_source === undefined) {
        throwHttpError('generate.chat_completion_source is required', 400);
    }

    if (Number(generate.n || 1) > 1) {
        throwHttpError('Multi-swipe generation is not supported by save-generate v1', 400);
    }

    if (Array.isArray(generate.tools) && generate.tools.length > 0) {
        throwHttpError('Tool calls are not supported by save-generate v1', 400);
    }
}

function resolveSaveGenerateChatFile(req, save) {
    const chatsRoot = req.user?.directories?.chats;
    if (!chatsRoot) {
        throwHttpError('User chats directory is unavailable', 500);
    }

    const avatarUrl = String(save.avatar_url || '');
    const fileName = String(save.file_name || '');
    const characterName = String(save.ch_name || save.char_name || save.name || '');
    const cardName = sanitizePathSegment(avatarUrl.replace(/\.png$/i, ''));
    const chatFileName = sanitizePathSegment(`${fileName}.jsonl`);

    if (!cardName || !chatFileName || chatFileName === '.jsonl') {
        throwHttpError('Invalid chat file identity', 400);
    }

    const directoryPath = path.join(chatsRoot, cardName);
    const filePath = path.join(directoryPath, chatFileName);
    if (!isPathUnderParent(chatsRoot, filePath)) {
        throwHttpError('Resolved chat path is outside user directory', 400);
    }

    return {
        kind: 'character',
        avatarUrl,
        fileName,
        characterName,
        cardName,
        directoryPath,
        filePath,
        backupName: characterName || cardName,
        backupDirectory: req.user?.directories?.backups,
        handle: req.user?.profile?.handle,
        requestUser: req.user,
    };
}

async function runSaveGenerateJob(job, { streamResponse = null } = {}) {
    if (job.cancelRequested) {
        throw makeSaveGenerateCancelError();
    }

    touchSaveGenerateJob(job, {
        status: job.generate.stream === true ? 'streaming' : 'running',
        startedAt: Date.now(),
        generateStartedAt: Date.now(),
    });

    const streamState = createStreamingState(job.generate.chat_completion_source);
    let clientOpen = Boolean(streamResponse);

    if (streamResponse) {
        streamResponse.on('close', () => {
            clientOpen = false;
        });
    }

    let response = null;

    try {
        response = await invokeChatCompletionsGenerate(job, {
            onChunk: chunk => {
                if (job.cancelRequested) {
                    return;
                }

                if (job.generate.stream === true) {
                    const clientChunks = streamState.push(chunk);
                    if (streamState.text || streamState.reasoning) {
                        touchSaveGenerateJob(job, {
                            resultText: streamState.text,
                            reasoning: streamState.reasoning,
                        });
                    }
                    if (clientOpen && streamResponse && !streamResponse.writableEnded) {
                        for (const clientChunk of clientChunks) {
                            streamResponse.write(clientChunk);
                        }
                    }
                    return;
                }

                if (clientOpen && streamResponse && !streamResponse.writableEnded) {
                    streamResponse.write(chunk);
                }
            },
            onStatus: capture => {
                job.responseStatus = capture.statusCode;
                job.responseStatusText = capture.statusMessage || '';
                if (clientOpen && streamResponse && !streamResponse.headersSent) {
                    copyCaptureHeadersToStream(streamResponse, capture);
                    streamResponse.statusCode = capture.statusCode;
                    streamResponse.statusMessage = capture.statusMessage || streamResponse.statusMessage;
                }
            },
        });

        touchSaveGenerateJob(job, { generateFinishedAt: Date.now() });

        if (job.cancelRequested) {
            throw makeSaveGenerateCancelError();
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
            if (job.cancelRequested) {
                throw makeSaveGenerateCancelError();
            }

            if (job.generate.stream === true && streamState.text) {
                await finishGeneratedResult(job, {
                    text: streamState.text,
                    reasoning: streamState.reasoning,
                });

                endStreamResponse(streamResponse, clientOpen);
                return { job, response };
            }

            const detail = response.bodyText || response.statusMessage || 'Generation failed';
            throwHttpError(detail, response.statusCode || SAVE_GENERATE_DEFAULT_ERROR_STATUS);
        }

        const result = job.generate.stream === true
            ? {
                text: streamState.text,
                reasoning: streamState.reasoning,
            }
            : extractNonStreamingResult(response.bodyText, job.generate.chat_completion_source);

        const text = String(result.text || '');
        if (!text) {
            const generationError = getGenerateErrorFromBody(response.bodyText) || 'Generation returned an empty assistant message';
            throwHttpError(generationError, response.statusCode >= 400 ? response.statusCode : 502);
        }

        await finishGeneratedResult(job, {
            text,
            reasoning: String(result.reasoning || ''),
        });

        endStreamResponse(streamResponse, clientOpen);
        return { job, response };
    } catch (error) {
        if (isSaveGenerateCancelError(error) || job.cancelRequested) {
            cancelSaveGenerateJob(job);
            endStreamResponse(streamResponse, clientOpen);
            return { job, response };
        }

        if (job.generate.stream === true && streamState.text) {
            await finishGeneratedResult(job, {
                text: streamState.text,
                reasoning: streamState.reasoning,
            });

            endStreamResponse(streamResponse, clientOpen);
            return { job, response };
        }

        failSaveGenerateJob(job, error);
        sendStreamErrorResponse(streamResponse, error, clientOpen);
        throw error;
    }
}

async function finishGeneratedResult(job, result) {
    touchSaveGenerateJob(job, {
        status: 'saving',
        resultText: String(result.text || ''),
        reasoning: String(result.reasoning || ''),
    });

    try {
        await saveGeneratedMessage(job);
    } catch (error) {
        failSaveGenerateJob(job, error);
    }
}

function sendCapturedGenerateResponse(res, response, job) {
    if (job?.status === 'canceled') {
        res.status(499).json({ error: { message: 'Generation canceled' }, canceled: true });
        return;
    }

    if (!response) {
        res.status(500).json({ error: { message: 'save-generate did not produce a response' } });
        return;
    }

    res.status(response.statusCode || 200);
    res.set('X-Baibaoku-Save-Generate-Status', job.status);

    for (const [key, value] of Object.entries(response.headers || {})) {
        if (/^(content-length|transfer-encoding)$/i.test(key)) {
            continue;
        }
        res.set(key, value);
    }

    if (!res.get('content-type')) {
        res.type('application/json; charset=utf-8');
    }

    res.send(response.body);
}

function sendGenerateErrorResponse(res, error) {
    const status = error.status || 500;
    const message = error.message || 'save-generate failed';
    res.status(status).json({ error: { message } });
}

function sendStreamErrorResponse(streamResponse, error, clientOpen) {
    if (!clientOpen || !streamResponse || streamResponse.writableEnded) {
        return;
    }

    const status = error.status || 500;
    const payload = JSON.stringify({ error: { message: error.message || 'save-generate failed' } });

    if (!streamResponse.headersSent) {
        streamResponse.status(status);
        streamResponse.type('application/json; charset=utf-8');
        streamResponse.end(payload);
        return;
    }

    streamResponse.write(`data: ${payload}\n\n`);
    streamResponse.end();
}

function endStreamResponse(streamResponse, clientOpen) {
    if (clientOpen && streamResponse && !streamResponse.writableEnded) {
        streamResponse.end();
    }
}

function getGenerateErrorFromBody(bodyText) {
    const sseError = getGenerateErrorFromSseBody(bodyText);
    if (sseError) {
        return sseError;
    }

    try {
        const data = JSON.parse(bodyText || '{}');
        return getGenerateErrorFromParsed(data);
    } catch {
        const text = String(bodyText || '').trim();
        if (text && text.length < 500) {
            return text;
        }
        return '';
    }
}

function getGenerateErrorFromSseBody(bodyText) {
    const text = String(bodyText || '');
    if (!text.includes('data:')) {
        return '';
    }

    for (const eventText of text.split(/\r?\n\r?\n/)) {
        const data = eventText
            .split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
            .join('\n');
        if (!data || data === '[DONE]') {
            continue;
        }

        try {
            const parsed = JSON.parse(data);
            const message = getGenerateErrorFromParsed(parsed);
            if (message) {
                return message;
            }
        } catch {
            // Ignore non-JSON streaming chunks.
        }
    }

    return '';
}

function getGenerateErrorFromParsed(data) {
    return data?.error?.message
        || (typeof data?.error === 'string' ? data.error : '')
        || data?.message
        || data?.detail?.error?.message
        || '';
}

function copyCaptureHeadersToStream(streamResponse, capture) {
    if (!streamResponse || streamResponse.headersSent) {
        return;
    }

    for (const [key, value] of Object.entries(capture.headers || {})) {
        if (/^(content-length|transfer-encoding)$/i.test(key)) {
            continue;
        }
        try {
            streamResponse.set(key, value);
        } catch {
            // Ignore invalid or late headers from the captured response.
        }
    }
}

async function invokeChatCompletionsGenerate(job, { onChunk, onStatus }) {
    const fakeReq = createGenerateRequest(job);
    const capture = new CaptureResponse({ onChunk, onStatus });
    job.captureResponse = capture;

    try {
        chatCompletionsRouter.handle(fakeReq, capture, error => {
            if (error) {
                capture.fail(error);
            } else if (!capture.writableEnded) {
                capture.end();
            }
        });

        await capture.done;
        return {
            statusCode: capture.statusCode,
            statusMessage: capture.statusMessage,
            headers: capture.headers,
            body: capture.body,
            bodyText: capture.body.toString('utf8'),
        };
    } finally {
        if (job.captureResponse === capture) {
            job.captureResponse = null;
        }
        job.generateRequestSocket = null;
    }
}

function createGenerateRequest(job) {
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.writable = true;
    socket.setTimeout = () => socket;
    job.generateRequestSocket = socket;

    return {
        method: 'POST',
        url: '/generate',
        originalUrl: '/api/backends/chat-completions/generate',
        baseUrl: '',
        path: '/generate',
        headers: {},
        body: structuredClone(job.generate),
        user: job.descriptor.requestUser,
        socket,
    };
}

class CaptureResponse extends Writable {
    constructor({ onChunk, onStatus }) {
        super();
        this.statusCode = 200;
        this.statusMessage = 'OK';
        this.headers = {};
        this.headersSent = false;
        this.socket = new EventEmitter();
        this.bodyChunks = [];
        this.onChunk = onChunk;
        this.onStatus = onStatus;
        this.statusNotified = false;
        this.done = new Promise((resolve, reject) => {
            this.once('finish', () => resolve());
            this.once('error', reject);
        });
    }

    get body() {
        return Buffer.concat(this.bodyChunks);
    }

    status(code) {
        this.statusCode = Number(code) || this.statusCode;
        return this;
    }

    set(field, value) {
        if (typeof field === 'string') {
            this.headers[field.toLowerCase()] = String(value);
        } else if (field && typeof field === 'object') {
            for (const [key, val] of Object.entries(field)) {
                this.headers[String(key).toLowerCase()] = String(val);
            }
        }
        return this;
    }

    setHeader(field, value) {
        return this.set(field, value);
    }

    getHeader(field) {
        return this.headers[String(field).toLowerCase()];
    }

    type(value) {
        this.set('content-type', value);
        return this;
    }

    json(value) {
        this.type('application/json; charset=utf-8');
        return this.send(JSON.stringify(value));
    }

    send(value = '') {
        if (value !== undefined && value !== null) {
            let body = value;
            if (typeof value === 'object' && !Buffer.isBuffer(value)) {
                if (!this.getHeader('content-type')) {
                    this.type('application/json; charset=utf-8');
                }
                body = JSON.stringify(value);
            }
            const chunk = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
            this.write(chunk);
        }
        this.end();
        return this;
    }

    sendStatus(code) {
        this.status(code);
        return this.send(String(code));
    }

    fail(error) {
        this.destroy(error);
    }

    _write(chunk, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk), 'utf8');
        this.notifyStatus();
        this.headersSent = true;
        this.bodyChunks.push(buffer);
        try {
            this.onChunk?.(buffer);
            callback();
        } catch (error) {
            callback(error);
        }
    }

    end(chunk, encoding, callback) {
        if (chunk !== undefined && chunk !== null) {
            return super.end(chunk, encoding, callback);
        }
        this.notifyStatus();
        this.headersSent = true;
        return super.end(callback);
    }

    notifyStatus() {
        if (this.statusNotified) {
            return;
        }
        this.statusNotified = true;
        this.onStatus?.(this);
    }
}

function createStreamingState(chatCompletionSource) {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    return {
        text: '',
        reasoning: '',
        push(chunk) {
            const clientChunks = [];
            buffer += decoder.write(chunk);

            while (true) {
                const match = /\r?\n\r?\n/.exec(buffer);
                if (!match) {
                    break;
                }

                const eventText = buffer.slice(0, match.index);
                const eventDelimiter = match[0];
                buffer = buffer.slice(match.index + eventDelimiter.length);
                const dataLines = eventText
                    .split(/\r?\n/)
                    .filter(line => line.startsWith('data:'))
                    .map(line => line.slice(5).trimStart());

                if (!dataLines.length) {
                    clientChunks.push(Buffer.from(`${eventText}${eventDelimiter}`, 'utf8'));
                    continue;
                }

                const data = dataLines.join('\n');
                if (data === '[DONE]') {
                    clientChunks.push(Buffer.from(`${eventText}${eventDelimiter}`, 'utf8'));
                    continue;
                }

                try {
                    const parsed = JSON.parse(data);
                    if (this.text && getGenerateErrorFromParsed(parsed)) {
                        continue;
                    }
                    const extracted = extractStreamingResult(parsed, chatCompletionSource);
                    this.text += extracted.text || '';
                    this.reasoning += extracted.reasoning || '';
                    clientChunks.push(Buffer.from(`${eventText}${eventDelimiter}`, 'utf8'));
                } catch {
                    clientChunks.push(Buffer.from(`${eventText}${eventDelimiter}`, 'utf8'));
                }
            }

            return clientChunks;
        },
    };
}

function extractStreamingResult(data, chatCompletionSource) {
    const source = chatCompletionSource;

    if (source === CHAT_COMPLETION_SOURCES.CLAUDE) {
        return {
            text: data?.delta?.text || '',
            reasoning: data?.delta?.thinking || '',
        };
    }

    if ([CHAT_COMPLETION_SOURCES.MAKERSUITE, CHAT_COMPLETION_SOURCES.VERTEXAI].includes(source)) {
        const parts = data?.candidates?.[0]?.content?.parts || [];
        return {
            text: parts.filter(x => !x.thought).map(x => x.text || '').join(''),
            reasoning: parts.filter(x => x.thought).map(x => x.text || '').join(''),
        };
    }

    if (source === CHAT_COMPLETION_SOURCES.COHERE) {
        return {
            text: data?.delta?.message?.content?.text || data?.delta?.message?.tool_plan || '',
            reasoning: '',
        };
    }

    if (source === CHAT_COMPLETION_SOURCES.MISTRALAI) {
        const content = data?.choices?.[0]?.delta?.content ?? data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
        return {
            text: Array.isArray(content) ? content.map(x => x.text || '').join('') : String(content || ''),
            reasoning: data?.choices?.filter(x => x?.delta?.content?.[0]?.thinking)?.[0]?.delta?.content?.[0]?.thinking?.[0]?.text || '',
        };
    }

    return {
        text: data?.choices?.[0]?.delta?.content ?? data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '',
        reasoning: data?.choices?.filter(x => x?.delta?.reasoning_content)?.[0]?.delta?.reasoning_content
            ?? data?.choices?.filter(x => x?.delta?.reasoning)?.[0]?.delta?.reasoning
            ?? data?.choices?.filter(x => x?.message?.reasoning_content)?.[0]?.message?.reasoning_content
            ?? data?.choices?.filter(x => x?.message?.reasoning)?.[0]?.message?.reasoning
            ?? '',
    };
}

function extractNonStreamingResult(bodyText, chatCompletionSource) {
    let data;
    try {
        data = JSON.parse(bodyText || '{}');
    } catch {
        return { text: bodyText || '', reasoning: '' };
    }

    const source = chatCompletionSource;
    let text = data?.content?.filter?.(part => part.type === 'text')?.map(part => part.text)?.join('\n\n')
        ?? data?.choices?.[0]?.message?.content
        ?? data?.choices?.[0]?.text
        ?? data?.text
        ?? data?.message?.content?.[0]?.text
        ?? data?.message?.tool_plan
        ?? '';

    if (Array.isArray(text)) {
        text = text.map(x => x?.text || '').join('');
    }

    let reasoning = data?.choices?.[0]?.message?.reasoning_content
        ?? data?.choices?.[0]?.message?.reasoning
        ?? '';

    if (source === CHAT_COMPLETION_SOURCES.CLAUDE) {
        reasoning = data?.content?.filter?.(part => part.type === 'thinking')?.map(part => part.thinking || part.text || '').join('\n\n') || reasoning;
    }

    return {
        text: String(text || ''),
        reasoning: String(reasoning || ''),
    };
}

async function saveGeneratedMessage(job) {
    const key = `${job.userHandle}:${job.descriptor.filePath}`;
    const previous = saveGenerateLocks.get(key) || Promise.resolve();
    const next = previous
        .catch(() => undefined)
        .then(() => saveGeneratedMessageLocked(job))
        .finally(() => {
            if (saveGenerateLocks.get(key) === next) {
                saveGenerateLocks.delete(key);
            }
        });

    saveGenerateLocks.set(key, next);
    return next;
}

async function saveGeneratedMessageLocked(job) {
    await fs.promises.mkdir(job.descriptor.directoryPath, { recursive: true });
    const chat = await readJsonlChat(job.descriptor.filePath);
    const currentVersion = await getChatVersion(job.descriptor.filePath);
    const expectedVersion = job.save.expectedVersion;
    const existingLastMessageInfo = getLastChatMessageInfo(chat);
    const existingLastMessage = existingLastMessageInfo.message;
    const generationType = getSaveGenerateType(job.save, job.generate);

    if (isSameGeneratedMessage(existingLastMessage, job)) {
        touchSaveGenerateJob(job, {
            status: 'already_saved',
            alreadySaved: true,
            savedMessage: existingLastMessage,
            savedMessageFloor: existingLastMessageInfo.floor,
            savedAt: Date.now(),
            finishedAt: Date.now(),
        });
        return;
    }

    if (expectedVersion && currentVersion !== expectedVersion) {
        touchSaveGenerateJob(job, {
            status: 'conflict',
            conflict: {
                expectedVersion,
                currentVersion,
            },
            finishedAt: Date.now(),
        });
        return;
    }

    const now = Date.now();
    const message = makeAssistantMessage(job, now);
    const baseChat = generationType === 'regenerate'
        ? removeLastRegeneratedMessage(chat)
        : chat;
    const savedMessageFloor = countSaveGenerateChatMessages(baseChat);
    const nextChat = appendChatMessage(baseChat, message);
    const preWriteVersion = await getChatVersion(job.descriptor.filePath);

    if (preWriteVersion !== currentVersion) {
        touchSaveGenerateJob(job, {
            status: 'conflict',
            conflict: {
                expectedVersion: currentVersion,
                currentVersion: preWriteVersion,
            },
            finishedAt: Date.now(),
        });
        return;
    }

    await saveChatCompat(
        nextChat,
        job.descriptor.filePath,
        false,
        job.descriptor.handle,
        job.descriptor.backupName,
        job.descriptor.backupDirectory,
    );

    touchSaveGenerateJob(job, {
        status: 'saved',
        savedMessage: message,
        savedMessageFloor,
        savedAt: Date.now(),
        finishedAt: Date.now(),
    });
}

async function saveChatCompat(chatData, filePath, skipIntegrityCheck = false, handle, cardName, backupDirectory) {
    if (typeof chatsEndpoint.trySaveChat === 'function') {
        return chatsEndpoint.trySaveChat(chatData, filePath, skipIntegrityCheck, handle, cardName, backupDirectory);
    }

    const jsonlData = chatData?.map(message => JSON.stringify(message)).join('\n');
    const doIntegrityCheck = saveGenerateChatIntegrityCheck && !skipIntegrityCheck;
    const chatIntegritySlug = doIntegrityCheck ? chatData?.[0]?.chat_metadata?.integrity : undefined;

    if (chatIntegritySlug && !await checkChatIntegrityCompat(filePath, chatIntegritySlug)) {
        const error = new Error(`Chat integrity check failed for "${filePath}". The expected integrity slug was "${chatIntegritySlug}".`);
        error.code = 'BAIBAOKU_CHAT_INTEGRITY';
        throw error;
    }

    writeFileAtomicSync(filePath, jsonlData, 'utf8');
    getSaveGenerateBackupFunction(handle)(backupDirectory, cardName, jsonlData);
}

async function checkChatIntegrityCompat(filePath, integritySlug) {
    if (!fs.existsSync(filePath)) {
        return true;
    }

    const firstLine = await readFirstLineCompat(filePath);
    const jsonData = tryParse(firstLine);
    const chatIntegrity = jsonData?.chat_metadata?.integrity;

    if (!chatIntegrity) {
        return true;
    }

    return chatIntegrity === integritySlug;
}

async function readFirstLineCompat(filePath) {
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(4096);
        let line = '';
        let position = 0;

        while (true) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
            if (!bytesRead) {
                return line;
            }

            const chunk = buffer.subarray(0, bytesRead).toString('utf8');
            const newlineIndex = chunk.indexOf('\n');
            if (newlineIndex !== -1) {
                return line + chunk.slice(0, newlineIndex);
            }

            line += chunk;
            position += bytesRead;
        }
    } finally {
        await handle.close();
    }
}

function getSaveGenerateBackupFunction(handle) {
    const key = handle || 'default';
    if (!saveGenerateBackupFunctions.has(key)) {
        saveGenerateBackupFunctions.set(key, _.throttle(backupChatCompat, saveGenerateChatBackupThrottleInterval, {
            leading: true,
            trailing: true,
        }));
    }

    return saveGenerateBackupFunctions.get(key) || (() => { });
}

function backupChatCompat(directory, name, chat) {
    try {
        if (!saveGenerateChatBackupsEnabled || !directory || !fs.existsSync(directory)) {
            return;
        }

        const safeName = sanitize(String(name || 'chat')).replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const backupFile = path.join(directory, `${SAVE_GENERATE_CHAT_BACKUPS_PREFIX}${safeName}_${generateTimestamp()}.jsonl`);
        writeFileAtomicSync(backupFile, chat, 'utf8');
        removeOldBackups(directory, `${SAVE_GENERATE_CHAT_BACKUPS_PREFIX}${safeName}_`);

        if (isNaN(saveGenerateChatBackupLimit) || saveGenerateChatBackupLimit < 0) {
            return;
        }

        removeOldBackups(directory, SAVE_GENERATE_CHAT_BACKUPS_PREFIX, saveGenerateChatBackupLimit);
    } catch (error) {
        console.error(`[baibaoku] Could not backup chat for ${name}`, error);
    }
}

function makeAssistantMessage(job, timestamp) {
    const sendDate = new Date(timestamp).toISOString();
    const genStarted = new Date(job.generateStartedAt || job.startedAt || timestamp).toISOString();
    const genFinished = new Date(job.generateFinishedAt || timestamp).toISOString();
    const extra = {
        api: job.generate.chat_completion_source || 'openai',
        model: job.generate.model || '',
        reasoning: job.reasoning || '',
        reasoning_duration: null,
        reasoning_signature: null,
    };
    const message = {
        name: job.descriptor.characterName || job.generate.char_name || job.descriptor.cardName,
        is_user: false,
        send_date: sendDate,
        mes: job.resultText,
        extra,
        gen_started: genStarted,
        gen_finished: genFinished,
        swipe_id: 0,
        swipes: [job.resultText],
        swipe_info: [{
            send_date: sendDate,
            gen_started: genStarted,
            gen_finished: genFinished,
            extra: structuredClone(extra),
        }],
    };

    return message;
}

function appendChatMessage(chat, message) {
    if (!Array.isArray(chat) || chat.length === 0) {
        return [{
            chat_metadata: {},
            user_name: 'unused',
            character_name: 'unused',
        }, message];
    }

    if (chat[0]?.chat_metadata && typeof chat[0].chat_metadata === 'object') {
        return [...chat, message];
    }

    return [{
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    }, ...chat, message];
}

function removeLastRegeneratedMessage(chat) {
    if (!Array.isArray(chat) || chat.length === 0) {
        return chat;
    }

    const nextChat = [...chat];
    for (let index = nextChat.length - 1; index >= 0; index -= 1) {
        const item = nextChat[index];
        if (!item || item.chat_metadata) {
            continue;
        }

        if (item.is_user !== true) {
            nextChat.splice(index, 1);
        }
        break;
    }

    return nextChat;
}

function isSameGeneratedMessage(message, job) {
    if (!message || message.is_user) {
        return false;
    }

    return String(message.mes || '') === String(job.resultText || '')
        && String(message.extra?.api || '') === String(job.generate.chat_completion_source || '')
        && String(message.extra?.model || '') === String(job.generate.model || '');
}

function getLastChatMessageInfo(chat) {
    const info = {
        message: null,
        floor: -1,
    };

    if (!Array.isArray(chat) || chat.length === 0) {
        return info;
    }

    let floor = -1;
    for (const item of chat) {
        if (!item || item.chat_metadata) {
            continue;
        }
        floor += 1;
        info.message = item;
        info.floor = floor;
    }

    return info;
}

function countSaveGenerateChatMessages(chat) {
    if (!Array.isArray(chat) || chat.length === 0) {
        return 0;
    }

    return chat.reduce((count, item) => count + (item && !item.chat_metadata ? 1 : 0), 0);
}

async function readJsonlChat(filePath) {
    try {
        const text = await fs.promises.readFile(filePath, 'utf8');
        if (!text) {
            return [];
        }

        return text
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            })
            .filter(Boolean);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

async function getChatVersion(filePath) {
    try {
        const stats = await fs.promises.stat(filePath);
        return `${stats.size}:${stats.mtimeMs}`;
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return '0:0';
        }
        throw error;
    }
}

function getSaveGenerateJobForRequest(req, jobId) {
    cleanupSaveGenerateJobs();

    const userHandle = req.user?.profile?.handle;
    if (!userHandle) {
        throwHttpError('Unauthorized', 401);
    }

    const id = String(jobId || '');
    const job = saveGenerateJobs.get(id);
    if (!job || job.userHandle !== userHandle) {
        throwHttpError('save-generate job was not found', 404);
    }

    return serializeSaveGenerateJob(job);
}

function cancelSaveGenerateJobForRequest(req, jobId, chatId = '') {
    cleanupSaveGenerateJobs();

    const userHandle = req.user?.profile?.handle;
    if (!userHandle) {
        throwHttpError('Unauthorized', 401);
    }

    const job = findSaveGenerateJobToCancel(userHandle, jobId, chatId);
    if (!job) {
        throwHttpError('cancelable save-generate job was not found', 404);
    }

    cancelSaveGenerateJob(job);
    return serializeSaveGenerateJob(job);
}

function findSaveGenerateJobToCancel(userHandle, jobId, chatId = '') {
    const id = String(jobId || '');
    if (id) {
        const job = saveGenerateJobs.get(id);
        if (!job || job.userHandle !== userHandle) {
            return null;
        }
        return job;
    }

    const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) {
        throwHttpError('jobId or chatId is required', 400);
    }

    let latest = null;
    for (const job of saveGenerateJobs.values()) {
        if (!job || job.userHandle !== userHandle || !isSaveGenerateCancelableStatus(job.status)) {
            continue;
        }

        const jobChatId = normalizeChatId(job.save?.chatId || job.save?.file_name);
        if (jobChatId !== normalizedChatId) {
            continue;
        }

        if (!latest || Number(job.updatedAt || 0) > Number(latest.updatedAt || 0)) {
            latest = job;
        }
    }

    return latest;
}

async function findSaveGenerateJobForChat(req, chatId, lastMessageHash = '') {
    cleanupSaveGenerateJobs();

    const userHandle = req.user?.profile?.handle;
    if (!userHandle) {
        throwHttpError('Unauthorized', 401);
    }

    const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) {
        throwHttpError('chatId is required', 400);
    }

    let latestPending = null;
    let latestTerminal = null;

    for (const job of saveGenerateJobs.values()) {
        if (!job || job.userHandle !== userHandle) {
            continue;
        }

        const jobChatId = normalizeChatId(job.save?.chatId || job.save?.file_name);
        if (jobChatId !== normalizedChatId) {
            continue;
        }

        if (isSaveGenerateTerminalStatus(job.status)) {
            if (!latestTerminal || Number(job.updatedAt || 0) > Number(latestTerminal.updatedAt || 0)) {
                latestTerminal = job;
            }
            continue;
        }

        if (!latestPending || Number(job.updatedAt || 0) > Number(latestPending.updatedAt || 0)) {
            latestPending = job;
        }
    }

    if (latestPending) {
        return serializeSaveGenerateJob(latestPending);
    }

    if (!latestTerminal) {
        return null;
    }

    if (isSaveGenerateSavedStatus(latestTerminal.status)
        && isSaveGenerateLastMessageHashMatch(latestTerminal, lastMessageHash)) {
        return null;
    }

    if (isSaveGenerateSavedStatus(latestTerminal.status)
        && await isSaveGenerateJobAlreadyAtChatTail(latestTerminal)) {
        return null;
    }

    return serializeSaveGenerateJob(latestTerminal);
}

async function isSaveGenerateJobAlreadyAtChatTail(job) {
    const filePath = job?.descriptor?.filePath;
    const expectedText = String(job?.savedMessage?.mes ?? job?.resultText ?? '');
    if (!filePath || !expectedText) {
        return false;
    }

    try {
        const chat = await readJsonlChat(filePath);
        const lastMessage = getLastChatMessageInfo(chat).message;
        return Boolean(lastMessage && lastMessage.is_user !== true && String(lastMessage.mes ?? '') === expectedText);
    } catch (error) {
        console.debug('[baibaoku] Could not verify save-generate chat tail:', error);
        return false;
    }
}

function serializeSaveGenerateJob(job) {
    return {
        id: job.id,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        savedAt: job.savedAt,
        responseStatus: job.responseStatus,
        responseStatusText: job.responseStatusText,
        cancelRequested: job.cancelRequested,
        canceledAt: job.canceledAt,
        save: job.save,
        resultText: job.resultText,
        reasoning: job.reasoning,
        savedMessage: job.savedMessage,
        savedMessageFloor: job.savedMessageFloor,
        conflict: job.conflict,
        alreadySaved: job.alreadySaved,
        error: job.error,
    };
}

function touchSaveGenerateJob(job, patch) {
    Object.assign(job, patch, { updatedAt: Date.now() });
}

function failSaveGenerateJob(job, error) {
    touchSaveGenerateJob(job, {
        status: 'failed',
        finishedAt: Date.now(),
        error: {
            message: error?.message || String(error),
            status: error?.status || null,
        },
    });
}

function cancelSaveGenerateJob(job) {
    if (!job || !isSaveGenerateCancelableStatus(job.status)) {
        return;
    }

    const now = Date.now();
    job.cancelRequested = true;
    job.canceledAt = job.canceledAt || now;

    closeSaveGenerateJobSockets(job);

    touchSaveGenerateJob(job, {
        status: 'canceled',
        finishedAt: now,
        generateFinishedAt: job.generateFinishedAt || now,
        resultText: '',
        reasoning: '',
        savedMessage: null,
        savedMessageFloor: null,
        error: {
            message: 'Generation canceled',
            status: 499,
        },
    });
}

function closeSaveGenerateJobSockets(job) {
    emitSaveGenerateSocketClose(job?.generateRequestSocket);
    emitSaveGenerateSocketClose(job?.captureResponse?.socket);

    if (job?.captureResponse && !job.captureResponse.writableEnded && !job.captureResponse.destroyed) {
        job.captureResponse.destroy(makeSaveGenerateCancelError());
    }
}

function emitSaveGenerateSocketClose(socket) {
    if (!socket || socket.destroyed) {
        return;
    }

    socket.destroyed = true;
    socket.emit('close');
}

function cleanupSaveGenerateJobs() {
    const now = Date.now();
    for (const [id, job] of saveGenerateJobs) {
        if (isSaveGenerateTerminalStatus(job.status) && now - job.updatedAt > SAVE_GENERATE_JOB_TTL_MS) {
            saveGenerateJobs.delete(id);
        }
    }

    while (saveGenerateJobs.size > SAVE_GENERATE_MAX_JOBS) {
        let oldestId = null;
        for (const [id, job] of saveGenerateJobs) {
            if (isSaveGenerateTerminalStatus(job.status)) {
                oldestId = id;
                break;
            }
        }
        if (!oldestId) {
            break;
        }
        saveGenerateJobs.delete(oldestId);
    }
}

function sanitizePathSegment(value) {
    return path.basename(String(value || ''))
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .trim();
}

function isPathUnderParent(parent, candidate) {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeExpectedVersion(value) {
    const text = String(value ?? '').trim();
    return text || '';
}

function normalizeChatId(value) {
    const text = String(value ?? '').trim();
    return text || '';
}

function getSaveGenerateType(save, generate) {
    return String(save?.type || generate?.type || 'normal');
}

function isSaveGenerateTerminalStatus(status) {
    return ['saved', 'already_saved', 'conflict', 'failed', 'canceled'].includes(status);
}

function isSaveGenerateSavedStatus(status) {
    return ['saved', 'already_saved'].includes(status);
}

function isSaveGenerateCancelableStatus(status) {
    return ['queued', 'running', 'streaming'].includes(status);
}

function makeSaveGenerateCancelError() {
    const error = new Error('Generation canceled');
    error.status = 499;
    error.saveGenerateCanceled = true;
    return error;
}

function isSaveGenerateCancelError(error) {
    return Boolean(error?.saveGenerateCanceled || error?.name === 'AbortError' && error?.message === 'Generation canceled');
}

function isSaveGenerateLastMessageHashMatch(job, lastMessageHash) {
    const expectedHash = String(lastMessageHash || '').trim();
    if (!expectedHash) {
        return false;
    }

    const expectedFloor = parseSaveGenerateMessageHashFloor(expectedHash);
    const savedFloor = Number.isInteger(job?.savedMessageFloor) ? job.savedMessageFloor : -1;
    if (Number.isInteger(expectedFloor) && Number.isInteger(savedFloor) && expectedFloor > savedFloor) {
        return true;
    }

    const savedText = job?.savedMessage?.mes ?? job?.resultText ?? '';
    return makeSaveGenerateMessageContentHash(savedText, savedFloor) === expectedHash;
}

function parseSaveGenerateMessageHashFloor(value) {
    const match = /^m(\d+):/.exec(String(value || ''));
    if (!match) {
        return null;
    }

    const floor = Number(match[1]);
    return Number.isInteger(floor) && floor >= 0 ? floor : null;
}

function makeSaveGenerateMessageContentHash(value, floor) {
    const text = String(value ?? '');
    const numericFloor = floor === null || floor === undefined ? -1 : Number(floor);
    const normalizedFloor = Number.isInteger(numericFloor) && numericFloor >= 0 ? numericFloor : -1;
    const hashInput = `${normalizedFloor}\n${text}`;
    let hash = 0x811c9dc5;
    for (let index = 0; index < hashInput.length; index += 1) {
        hash ^= hashInput.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return `m${normalizedFloor}:${text.length.toString(36)}:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function throwHttpError(message, status) {
    const error = new Error(message);
    error.status = status;
    throw error;
}
