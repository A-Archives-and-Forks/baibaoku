import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import { router as chatCompletionsRouter } from '../../../src/endpoints/backends/chat-completions.js';
import { CHAT_COMPLETION_SOURCES } from '../../../src/constants.js';
import { tryParse } from '../../../src/util.js';
import { loadSqliteDriver } from './database.js';
import { setHeaderIfValid, setSafeHeader } from './header-utils.js';
import { getStoragePaths } from './paths.js';

const SAVE_GENERATE_JOB_TTL_MS = 2 * 24 * 60 * 60 * 1000;
const SAVE_GENERATE_MAX_JOBS = 200;
const SAVE_GENERATE_DEFAULT_ERROR_STATUS = 500;
const SAVE_GENERATE_PERSIST_VERSION = 1;
const SAVE_GENERATE_DATABASE = 'baibaoku.internal';
const SAVE_GENERATE_LEGACY_PERSIST_DIRECTORY = 'save-generate-jobs';
const SAVE_GENERATE_EVENT_HEARTBEAT_MS = 15_000;
const SAVE_GENERATE_EVENT_UPDATE_MIN_MS = 250;

const saveGenerateJobs = new Map();
const saveGenerateDbConnections = new Map();
const saveGenerateLegacyMigrationUsers = new Set();

export function registerSaveGenerateEndpoints(router) {
    router.post('/v1/chats/save-generate', async (req, res) => {
        try {
            const job = createSaveGenerateJob(req);
            const isStream = job.generate.stream === true;
            setSafeHeader(res, 'X-Baibaoku-Save-Generate-Job-Id', job.id);

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

    router.post('/v1/chats/save-generate/status', async (req, res) => {
        try {
            res.json({
                ok: true,
                data: await getSaveGenerateJobForRequest(req, req.body?.jobId || req.body?.id),
            });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.post('/v1/chats/save-generate/cancel', async (req, res) => {
        try {
            res.json({
                ok: true,
                data: await cancelSaveGenerateJobForRequest(
                    req,
                    req.body?.jobId || req.body?.id,
                    req.body?.chatId || req.body?.chat_id,
                ),
            });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.post('/v1/chats/save-generate/discard', async (req, res) => {
        try {
            res.json({
                ok: true,
                data: await discardSaveGenerateJobsForRequest(req, req.body?.chatId || req.body?.chat_id),
            });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.post('/v1/chats/save-generate/:jobId/cancel', async (req, res) => {
        try {
            res.json({
                ok: true,
                data: await cancelSaveGenerateJobForRequest(req, req.params?.jobId),
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
                    {
                        floor: req.query?.lastMessageFloor ?? req.query?.last_message_floor,
                        role: req.query?.lastMessageRole ?? req.query?.last_message_role,
                    },
                ),
            });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.get('/v1/chats/save-generate/:jobId/events', async (req, res) => {
        try {
            await streamSaveGenerateJobEventsForRequest(req, res, req.params?.jobId);
        } catch (error) {
            if (!res.headersSent && !res.writableEnded) {
                res.status(error.status || 500).json({ ok: false, error: true, message: error.message });
            } else if (!res.writableEnded) {
                res.end();
            }
        }
    });

    router.get('/v1/chats/save-generate/:jobId', async (req, res) => {
        try {
            res.json({
                ok: true,
                data: await getSaveGenerateJobForRequest(req, req.params?.jobId),
            });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: true, message: error.message });
        }
    });
}

export function closeSaveGenerateJobs() {
    saveGenerateJobs.clear();
    saveGenerateLegacyMigrationUsers.clear();
    for (const db of saveGenerateDbConnections.values()) {
        try {
            db.pragma('wal_checkpoint(TRUNCATE)');
            db.close();
        } catch {
            // Ignore close errors during server shutdown.
        }
    }
    saveGenerateDbConnections.clear();
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
        persistedAt: null,
        chatSaved: false,
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
        persistenceVersion: SAVE_GENERATE_PERSIST_VERSION,
        generateRequestSocket: null,
        captureResponse: null,
        events: new EventEmitter(),
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

function getSaveGenerateLegacyPersistDirectory(userRoot) {
    const root = path.resolve(userRoot);
    const directory = path.resolve(root, 'baibaoku', SAVE_GENERATE_LEGACY_PERSIST_DIRECTORY);
    if (!isPathUnderParent(root, directory)) {
        throwHttpError('Resolved legacy save-generate persist path is outside user directory', 400);
    }
    return directory;
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

                writeStreamChunksToClient(streamResponse, clientOpen, streamState.takeDoneChunks());
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

        if (job.generate.stream === true) {
            writeStreamChunksToClient(streamResponse, clientOpen, streamState.takeDoneChunks());
        }
        endStreamResponse(streamResponse, clientOpen);
        return { job, response };
    } catch (error) {
        if (isSaveGenerateCancelError(error) || job.cancelRequested) {
            await cancelSaveGenerateJob(job);
            endStreamResponse(streamResponse, clientOpen);
            return { job, response };
        }

        if (job.generate.stream === true && streamState.text) {
            await finishGeneratedResult(job, {
                text: streamState.text,
                reasoning: streamState.reasoning,
            });

            writeStreamChunksToClient(streamResponse, clientOpen, streamState.takeDoneChunks());
            endStreamResponse(streamResponse, clientOpen);
            return { job, response };
        }

        await failSaveGenerateJob(job, error);
        sendStreamErrorResponse(streamResponse, error, clientOpen);
        throw error;
    }
}

async function finishGeneratedResult(job, result) {
    touchSaveGenerateJob(job, {
        status: 'persisting',
        resultText: String(result.text || ''),
        reasoning: String(result.reasoning || ''),
    });

    try {
        await persistGeneratedResult(job);
    } catch (error) {
        await failSaveGenerateJob(job, error);
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
    setSafeHeader(res, 'X-Baibaoku-Save-Generate-Status', job.status);

    for (const [key, value] of Object.entries(response.headers || {})) {
        if (/^(content-length|transfer-encoding)$/i.test(key)) {
            continue;
        }
        setHeaderIfValid(res, key, value);
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

function writeStreamChunksToClient(streamResponse, clientOpen, chunks) {
    if (!clientOpen || !streamResponse || streamResponse.writableEnded || !Array.isArray(chunks)) {
        return;
    }

    for (const chunk of chunks) {
        streamResponse.write(chunk);
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
            setHeaderIfValid(streamResponse, key, value);
        } catch {
            // Ignore late headers from the captured response.
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
    const doneChunks = [];
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
                    doneChunks.push(Buffer.from(`${eventText}${eventDelimiter}`, 'utf8'));
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
        takeDoneChunks() {
            return doneChunks.splice(0, doneChunks.length);
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

async function persistGeneratedResult(job) {
    const now = Date.now();
    const message = makeAssistantMessage(job, now);
    const savedMessageFloor = await estimateGeneratedMessageFloor(job);

    touchSaveGenerateJob(job, {
        status: 'completed',
        savedMessage: message,
        savedMessageFloor,
        savedAt: null,
        persistedAt: now,
        chatSaved: false,
        finishedAt: now,
    });
    await persistSaveGenerateJob(job, { required: true });
}

async function estimateGeneratedMessageFloor(job) {
    try {
        const chat = await readJsonlChat(job.descriptor.filePath);
        const generationType = getSaveGenerateType(job.save, job.generate);
        const baseChat = generationType === 'regenerate'
            ? removeLastRegeneratedMessage(chat)
            : chat;
        return countSaveGenerateChatMessages(baseChat);
    } catch (error) {
        console.debug('[baibaoku] Could not estimate save-generate message floor:', error);
        return -1;
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

async function persistSaveGenerateJob(job, { required = false } = {}) {
    if (!job || !isSaveGenerateTerminalStatus(job.status)) {
        return false;
    }

    try {
        const db = await getSaveGenerateDb(job.descriptor?.requestUser);
        const payload = serializeSaveGenerateJobForPersistence(job);
        const expiresAt = Number(job.updatedAt || Date.now()) + SAVE_GENERATE_JOB_TTL_MS;
        db.prepare(`
            INSERT INTO save_generate_jobs (
                id,
                user_handle,
                chat_id,
                status,
                created_at,
                updated_at,
                finished_at,
                expires_at,
                payload
            )
            VALUES (@id, @userHandle, @chatId, @status, @createdAt, @updatedAt, @finishedAt, @expiresAt, @payload)
            ON CONFLICT(id) DO UPDATE SET
                user_handle = excluded.user_handle,
                chat_id = excluded.chat_id,
                status = excluded.status,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                finished_at = excluded.finished_at,
                expires_at = excluded.expires_at,
                payload = excluded.payload
        `).run({
            id: job.id,
            userHandle: job.userHandle,
            chatId: normalizeChatId(job.save?.chatId || job.save?.file_name),
            status: job.status,
            createdAt: Number(job.createdAt || Date.now()),
            updatedAt: Number(job.updatedAt || Date.now()),
            finishedAt: job.finishedAt || null,
            expiresAt,
            payload: JSON.stringify(payload),
        });
        return true;
    } catch (error) {
        if (required) {
            throw error;
        }
        console.warn('[baibaoku] Failed to persist save-generate job:', error.message);
        return false;
    }
}

async function getSaveGenerateDb(reqOrUser) {
    const req = reqOrUser?.directories ? { user: reqOrUser } : reqOrUser;
    const userRoot = req?.user?.directories?.root;
    if (!userRoot) {
        throwHttpError('User data directory is unavailable', 500);
    }

    const paths = getStoragePaths(req, SAVE_GENERATE_DATABASE);
    const databasePath = path.resolve(paths.databasePath);
    if (saveGenerateDbConnections.has(databasePath)) {
        return saveGenerateDbConnections.get(databasePath);
    }

    const driver = await loadSqliteDriver();
    const db = driver.open(databasePath);
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 512');
    db.pragma('journal_size_limit = 67108864');
    db.pragma('busy_timeout = 5000');
    db.exec(`
        CREATE TABLE IF NOT EXISTS save_generate_jobs (
            id TEXT PRIMARY KEY,
            user_handle TEXT NOT NULL,
            chat_id TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            finished_at INTEGER,
            expires_at INTEGER NOT NULL,
            payload TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_save_generate_jobs_user_chat_updated
            ON save_generate_jobs(user_handle, chat_id, updated_at DESC);

        CREATE INDEX IF NOT EXISTS idx_save_generate_jobs_expires
            ON save_generate_jobs(expires_at);
    `);
    saveGenerateDbConnections.set(databasePath, db);
    return db;
}

function serializeSaveGenerateJobForPersistence(job) {
    return {
        id: job.id,
        userHandle: job.userHandle,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        generateStartedAt: job.generateStartedAt,
        generateFinishedAt: job.generateFinishedAt,
        savedAt: job.savedAt,
        persistedAt: job.persistedAt,
        chatSaved: job.chatSaved === true,
        responseStatus: job.responseStatus,
        responseStatusText: job.responseStatusText,
        cancelRequested: job.cancelRequested === true,
        canceledAt: job.canceledAt,
        save: job.save,
        generate: job.generate,
        resultText: job.resultText,
        reasoning: job.reasoning,
        savedMessage: job.savedMessage,
        savedMessageFloor: job.savedMessageFloor,
        conflict: job.conflict,
        alreadySaved: job.alreadySaved === true,
        error: job.error,
        persistenceVersion: SAVE_GENERATE_PERSIST_VERSION,
    };
}

async function ensureSaveGeneratePersistenceReady(req) {
    const userHandle = req.user?.profile?.handle;
    if (!userHandle) {
        throwHttpError('Unauthorized', 401);
    }

    const userRoot = req.user?.directories?.root;
    if (!userRoot) {
        throwHttpError('User data directory is unavailable', 500);
    }

    const db = await getSaveGenerateDb(req);
    cleanupPersistedSaveGenerateJobs(db);
    await migrateLegacyPersistedSaveGenerateJobs(req, db, userRoot);
}

function restorePersistedSaveGenerateJob(req, payload) {
    const rawJob = payload?.job || payload;
    const version = payload?.version || rawJob?.persistenceVersion;
    if (version !== SAVE_GENERATE_PERSIST_VERSION || !rawJob || typeof rawJob !== 'object') {
        return null;
    }

    if (!rawJob.id || !isSaveGenerateTerminalStatus(rawJob.status)) {
        return null;
    }

    const userHandle = req.user?.profile?.handle;
    if (rawJob.userHandle !== userHandle) {
        return null;
    }

    if (Date.now() - Number(rawJob.updatedAt || rawJob.finishedAt || rawJob.createdAt || 0) > SAVE_GENERATE_JOB_TTL_MS) {
        return null;
    }

    const save = rawJob.save && typeof rawJob.save === 'object' ? rawJob.save : null;
    if (!save) {
        return null;
    }

    const descriptor = resolveSaveGenerateChatFile(req, {
        avatar_url: save.avatar_url,
        file_name: save.file_name,
        ch_name: save.ch_name,
        chatId: save.chatId,
    });

    return {
        id: String(rawJob.id),
        userHandle,
        status: String(rawJob.status),
        createdAt: Number(rawJob.createdAt || Date.now()),
        updatedAt: Number(rawJob.updatedAt || rawJob.finishedAt || rawJob.createdAt || Date.now()),
        startedAt: rawJob.startedAt || null,
        finishedAt: rawJob.finishedAt || null,
        generateStartedAt: rawJob.generateStartedAt || null,
        generateFinishedAt: rawJob.generateFinishedAt || null,
        savedAt: rawJob.savedAt || null,
        persistedAt: rawJob.persistedAt || null,
        chatSaved: rawJob.chatSaved === true,
        error: rawJob.error || null,
        resultText: String(rawJob.resultText || ''),
        reasoning: String(rawJob.reasoning || ''),
        responseStatus: rawJob.responseStatus || null,
        responseStatusText: rawJob.responseStatusText || '',
        cancelRequested: rawJob.cancelRequested === true,
        canceledAt: rawJob.canceledAt || null,
        save: {
            kind: save.kind || 'character',
            type: String(save.type || 'normal'),
            chatId: normalizeChatId(save.chatId || save.file_name),
            avatar_url: String(save.avatar_url || ''),
            file_name: String(save.file_name || ''),
            ch_name: String(save.ch_name || ''),
            expectedVersion: normalizeExpectedVersion(save.expectedVersion ?? save.expected_version),
        },
        descriptor,
        generate: rawJob.generate && typeof rawJob.generate === 'object' ? rawJob.generate : {},
        savedMessage: rawJob.savedMessage || null,
        savedMessageFloor: Number.isInteger(rawJob.savedMessageFloor) ? rawJob.savedMessageFloor : -1,
        conflict: rawJob.conflict || null,
        alreadySaved: rawJob.alreadySaved === true,
        persistenceVersion: SAVE_GENERATE_PERSIST_VERSION,
        generateRequestSocket: null,
        captureResponse: null,
    };
}

function cleanupPersistedSaveGenerateJobs(db) {
    db.prepare('DELETE FROM save_generate_jobs WHERE expires_at <= ?').run(Date.now());
}

async function getPersistedSaveGenerateJob(req, id) {
    if (!id) {
        return null;
    }

    const userHandle = req.user?.profile?.handle;
    const db = await getSaveGenerateDb(req);
    const row = db.prepare(`
        SELECT payload
        FROM save_generate_jobs
        WHERE id = ? AND user_handle = ? AND expires_at > ?
    `).get(id, userHandle, Date.now());

    return row ? restorePersistedSaveGenerateJob(req, tryParse(row.payload)) : null;
}

async function findPersistedSaveGenerateJobForChat(req, chatId) {
    const userHandle = req.user?.profile?.handle;
    const normalizedChatId = normalizeChatId(chatId);
    if (!userHandle || !normalizedChatId) {
        return null;
    }

    const db = await getSaveGenerateDb(req);
    const row = db.prepare(`
        SELECT payload
        FROM save_generate_jobs
        WHERE user_handle = ?
          AND chat_id = ?
          AND expires_at > ?
        ORDER BY updated_at DESC
        LIMIT 1
    `).get(userHandle, normalizedChatId, Date.now());

    return row ? restorePersistedSaveGenerateJob(req, tryParse(row.payload)) : null;
}

async function migrateLegacyPersistedSaveGenerateJobs(req, db, userRoot) {
    const userHandle = req.user?.profile?.handle;
    const directory = getSaveGenerateLegacyPersistDirectory(userRoot);
    const migrationKey = `${userHandle}:${directory}`;
    if (saveGenerateLegacyMigrationUsers.has(migrationKey)) {
        return;
    }

    saveGenerateLegacyMigrationUsers.add(migrationKey);

    let entries = [];
    try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return;
        }
        throw error;
    }

    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
            continue;
        }

        const filePath = path.join(directory, entry.name);
        try {
            const payload = tryParse(await fs.promises.readFile(filePath, 'utf8'));
            const job = restorePersistedSaveGenerateJob(req, payload);
            if (job) {
                const dbPayload = serializeSaveGenerateJobForPersistence(job);
                const expiresAt = Number(job.updatedAt || Date.now()) + SAVE_GENERATE_JOB_TTL_MS;
                db.prepare(`
                    INSERT INTO save_generate_jobs (
                        id,
                        user_handle,
                        chat_id,
                        status,
                        created_at,
                        updated_at,
                        finished_at,
                        expires_at,
                        payload
                    )
                    VALUES (@id, @userHandle, @chatId, @status, @createdAt, @updatedAt, @finishedAt, @expiresAt, @payload)
                    ON CONFLICT(id) DO NOTHING
                `).run({
                    id: job.id,
                    userHandle: job.userHandle,
                    chatId: normalizeChatId(job.save?.chatId || job.save?.file_name),
                    status: job.status,
                    createdAt: Number(job.createdAt || Date.now()),
                    updatedAt: Number(job.updatedAt || Date.now()),
                    finishedAt: job.finishedAt || null,
                    expiresAt,
                    payload: JSON.stringify(dbPayload),
                });
            }
            await fs.promises.unlink(filePath);
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                console.warn(`[baibaoku] Failed to migrate legacy save-generate job ${entry.name}:`, error.message);
            }
        }
    }
}

async function getSaveGenerateRawJobForRequest(req, jobId) {
    cleanupSaveGenerateJobs();

    const userHandle = req.user?.profile?.handle;
    if (!userHandle) {
        throwHttpError('Unauthorized', 401);
    }

    const id = String(jobId || '');
    let job = saveGenerateJobs.get(id);
    if (!job) {
        try {
            await ensureSaveGeneratePersistenceReady(req);
            job = await getPersistedSaveGenerateJob(req, id);
        } catch (error) {
            console.debug('[baibaoku] Could not query persisted save-generate job:', error.message);
        }
    }
    if (!job || job.userHandle !== userHandle) {
        throwHttpError('save-generate job was not found', 404);
    }

    return job;
}

async function getSaveGenerateJobForRequest(req, jobId) {
    const job = await getSaveGenerateRawJobForRequest(req, jobId);
    return serializeSaveGenerateJob(job);
}

async function streamSaveGenerateJobEventsForRequest(req, res, jobId) {
    const job = await getSaveGenerateRawJobForRequest(req, jobId);
    res.status(200);
    res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }

    let closed = false;
    let pendingTimer = null;
    let lastSentAt = 0;

    const writeEvent = (event, data = null) => {
        if (closed || res.writableEnded) {
            return false;
        }

        res.write(`event: ${event}\n`);
        if (data !== null && data !== undefined) {
            res.write(`data: ${JSON.stringify(data)}\n`);
        }
        res.write('\n');
        if (typeof res.flush === 'function') {
            res.flush();
        }
        lastSentAt = Date.now();
        return true;
    };

    const close = () => {
        if (closed) {
            return;
        }

        closed = true;
        if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
        }
        job.events?.off?.('update', handleUpdate);
        if (!res.writableEnded) {
            res.end();
        }
    };

    const sendSnapshot = (event = 'snapshot') => {
        if (!writeEvent(event, serializeSaveGenerateJob(job))) {
            return;
        }

        if (isSaveGenerateTerminalStatus(job.status)) {
            close();
        }
    };

    const handleUpdate = () => {
        if (isSaveGenerateTerminalStatus(job.status)) {
            if (pendingTimer) {
                clearTimeout(pendingTimer);
                pendingTimer = null;
            }
            sendSnapshot('done');
            return;
        }

        const elapsed = Date.now() - lastSentAt;
        if (elapsed >= SAVE_GENERATE_EVENT_UPDATE_MIN_MS) {
            sendSnapshot('snapshot');
            return;
        }

        if (!pendingTimer) {
            pendingTimer = setTimeout(() => {
                pendingTimer = null;
                sendSnapshot('snapshot');
            }, SAVE_GENERATE_EVENT_UPDATE_MIN_MS - elapsed);
        }
    };

    if (!isSaveGenerateTerminalStatus(job.status)) {
        getSaveGenerateJobEmitter(job).on('update', handleUpdate);
    }

    res.on('close', close);
    writeEvent('hello', { id: job.id });
    sendSnapshot(isSaveGenerateTerminalStatus(job.status) ? 'done' : 'snapshot');

    if (isSaveGenerateTerminalStatus(job.status)) {
        return;
    }

    const heartbeat = setInterval(() => {
        if (isSaveGenerateTerminalStatus(job.status)) {
            sendSnapshot('done');
            clearInterval(heartbeat);
            return;
        }

        if (!writeEvent('ping', { updatedAt: job.updatedAt })) {
            clearInterval(heartbeat);
        }
    }, SAVE_GENERATE_EVENT_HEARTBEAT_MS);

    res.on('close', () => clearInterval(heartbeat));
}

async function cancelSaveGenerateJobForRequest(req, jobId, chatId = '') {
    cleanupSaveGenerateJobs();

    const userHandle = req.user?.profile?.handle;
    if (!userHandle) {
        throwHttpError('Unauthorized', 401);
    }

    const job = findSaveGenerateJobToCancel(userHandle, jobId, chatId);
    if (!job) {
        throwHttpError('cancelable save-generate job was not found', 404);
    }

    await cancelSaveGenerateJob(job);
    return serializeSaveGenerateJob(job);
}

async function discardSaveGenerateJobsForRequest(req, chatId = '') {
    cleanupSaveGenerateJobs();

    const userHandle = req.user?.profile?.handle;
    if (!userHandle) {
        throwHttpError('Unauthorized', 401);
    }

    const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) {
        throwHttpError('chatId is required', 400);
    }

    const now = Date.now();
    let memoryDiscarded = 0;
    for (const [id, job] of saveGenerateJobs.entries()) {
        if (!job || job.userHandle !== userHandle) {
            continue;
        }

        const jobChatId = normalizeChatId(job.save?.chatId || job.save?.file_name);
        if (jobChatId !== normalizedChatId) {
            continue;
        }

        discardSaveGenerateJobInMemory(job, now);
        saveGenerateJobs.delete(id);
        memoryDiscarded += 1;
    }

    let persistedDiscarded = 0;
    try {
        await ensureSaveGeneratePersistenceReady(req);
        const db = await getSaveGenerateDb(req);
        const result = db.prepare(`
            DELETE FROM save_generate_jobs
            WHERE user_handle = ?
              AND chat_id = ?
        `).run(userHandle, normalizedChatId);
        persistedDiscarded = Number(result?.changes || 0);
    } catch (error) {
        console.warn('[baibaoku] Failed to discard persisted save-generate jobs:', error.message);
        throw error;
    }

    return {
        chatId: normalizedChatId,
        discarded: memoryDiscarded + persistedDiscarded,
        memoryDiscarded,
        persistedDiscarded,
    };
}

function discardSaveGenerateJobInMemory(job, now = Date.now()) {
    if (!job) {
        return;
    }

    job.discardRequested = true;
    job.cancelRequested = true;
    job.canceledAt = job.canceledAt || now;
    touchSaveGenerateJob(job, {
        status: 'canceled',
        finishedAt: now,
        generateFinishedAt: job.generateFinishedAt || now,
        resultText: '',
        reasoning: '',
        savedMessage: null,
        savedMessageFloor: null,
        error: {
            message: 'Generation discarded because chat messages changed',
            status: 499,
        },
    });
    closeSaveGenerateJobSockets(job);
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

async function findSaveGenerateJobForChat(req, chatId, lastMessageHash = '', lastMessageInfo = {}) {
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

    try {
        await ensureSaveGeneratePersistenceReady(req);
        const persistedTerminal = await findPersistedSaveGenerateJobForChat(req, normalizedChatId);
        if (persistedTerminal && (!latestTerminal || Number(persistedTerminal.updatedAt || 0) > Number(latestTerminal.updatedAt || 0))) {
            latestTerminal = persistedTerminal;
        }
    } catch (error) {
        console.debug('[baibaoku] Could not query persisted save-generate jobs:', error.message);
    }

    if (!latestTerminal) {
        return null;
    }

    if (isSaveGenerateSavedStatus(latestTerminal.status)
        && isSaveGenerateClientTailAlreadyHasJob(latestTerminal, lastMessageInfo)) {
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
        const lastMessageInfo = getLastChatMessageInfo(chat);
        const lastMessage = lastMessageInfo.message;
        if (isSaveGenerateClientTailAlreadyHasJob(job, {
            floor: lastMessageInfo.floor,
            role: lastMessage ? (lastMessage.is_user === true ? 'user' : 'assistant') : '',
        })) {
            return true;
        }

        return Boolean(
            lastMessage
            && lastMessage.is_user !== true
            && isSaveGenerateTextIncludedInMessage(lastMessage.mes, expectedText),
        );
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
        persistedAt: job.persistedAt,
        chatSaved: job.chatSaved === true,
        persistenceVersion: job.persistenceVersion || SAVE_GENERATE_PERSIST_VERSION,
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
    emitSaveGenerateJobUpdate(job);
}

function getSaveGenerateJobEmitter(job) {
    if (!job.events) {
        job.events = new EventEmitter();
    }
    job.events.setMaxListeners(0);
    return job.events;
}

function emitSaveGenerateJobUpdate(job) {
    job?.events?.emit?.('update', job);
}

async function failSaveGenerateJob(job, error) {
    touchSaveGenerateJob(job, {
        status: 'failed',
        finishedAt: Date.now(),
        error: {
            message: error?.message || String(error),
            status: error?.status || null,
        },
    });
    await persistSaveGenerateJob(job);
}

async function cancelSaveGenerateJob(job) {
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
    if (!job.discardRequested) {
        await persistSaveGenerateJob(job);
    }
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
    return ['completed', 'saved', 'already_saved', 'conflict', 'failed', 'canceled'].includes(status);
}

function isSaveGenerateSavedStatus(status) {
    return ['completed', 'saved', 'already_saved'].includes(status);
}

function isSaveGenerateCancelableStatus(status) {
    return ['queued', 'running', 'streaming', 'persisting'].includes(status);
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

    const savedFloor = Number.isInteger(job?.savedMessageFloor) ? job.savedMessageFloor : -1;
    const savedText = job?.savedMessage?.mes ?? job?.resultText ?? '';
    return makeSaveGenerateMessageContentHash(savedText, savedFloor) === expectedHash;
}

function isSaveGenerateClientTailAlreadyHasJob(job, lastMessageInfo = {}) {
    const savedFloor = Number.isInteger(job?.savedMessageFloor) ? job.savedMessageFloor : -1;
    const lastFloor = normalizeSaveGenerateMessageFloor(lastMessageInfo?.floor);
    const lastRole = normalizeSaveGenerateMessageRole(lastMessageInfo?.role);
    return savedFloor >= 0 && lastFloor >= savedFloor && lastRole === 'assistant';
}

function normalizeSaveGenerateMessageFloor(value) {
    if (Number.isInteger(value)) {
        return value >= 0 ? value : -1;
    }

    const text = String(value ?? '').trim();
    if (!/^\d+$/.test(text)) {
        return -1;
    }

    const floor = Number(text);
    return Number.isSafeInteger(floor) && floor >= 0 ? floor : -1;
}

function normalizeSaveGenerateMessageRole(value) {
    const role = String(value ?? '').trim().toLowerCase();
    return role === 'assistant' || role === 'user' ? role : '';
}

function normalizeSaveGenerateComparableText(value) {
    return String(value ?? '')
        .replace(/^\uFEFF/, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\n?data:\s*\[DONE\]\s*$/i, '')
        .trim();
}

function isSaveGenerateTextIncludedInMessage(messageText, jobText) {
    const normalizedMessage = normalizeSaveGenerateComparableText(messageText);
    const normalizedJobText = normalizeSaveGenerateComparableText(jobText);
    return Boolean(normalizedJobText && normalizedMessage.includes(normalizedJobText));
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
