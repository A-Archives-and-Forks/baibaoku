import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { getCompleteResponseToolName, normalizeCompleteResponse } from '../src/save-generate-tools.js';

const name = 'emit_complete_response_test123';
const body = () => ({ type: 'normal', stream: true, chat_completion_source: 'openai', tool_choice: 'auto',
    tools: [{ type: 'function', function: { name, parameters: { type: 'object',
        properties: { content: { type: 'string' } }, required: ['content'] } } }] });
const reply = '完整正文 🙂\n"quoted" \\ path';
const proxyError = '### **Proxy error (HTTP 503 Service Unavailable)**\n<!-- oai-proxy-error -->';
const event = data => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const delta = (value, finish_reason = null) => ({ choices: [{ index: 0, delta: value, finish_reason }] });
const call = (args, functionName = name, index = 0) => ({ index, type: 'function', function: { name: functionName, arguments: args } });
const fullReply = content => ({ choices: [{ message: { role: 'assistant', content: null,
    tool_calls: [call(JSON.stringify({ content }))] }, finish_reason: 'tool_calls' }] });

// Exercise actual capture, parsing and job finalization; replace only ST routing and disk persistence.
async function loadBackend(serve = (_req, res) => res.end()) {
    const context = vm.createContext({ Buffer, structuredClone, console, setTimeout, clearTimeout });
    const code = await readFile(new URL('../src/save-generate.js', import.meta.url), 'utf8');
    const source = new vm.SourceTextModule(code + `
        persistGeneratedResult = async job => { job.status = 'completed'; job.testSaved = job.resultText; };
        persistSaveGenerateJob = async () => {};
        export { createStreamingState, extractNonStreamingResult, validateSaveGenerateRequest, runSaveGenerateJob, sendCapturedGenerateResponse };
    `, { context });
    await source.link(async specifier => {
        let exports;
        if (specifier.startsWith('node:')) exports = await import(specifier);
        else if (specifier === './save-generate-tools.js' || specifier === './header-utils.js') exports = await import(new URL(`../src/${specifier}`, import.meta.url));
        else if (specifier.endsWith('/chat-completions.js')) exports = { router: { handle: serve } };
        else if (specifier.endsWith('/constants.js')) exports = { CHAT_COMPLETION_SOURCES: { OPENAI: 'openai', CLAUDE: 'claude', MAKERSUITE: 'makersuite', VERTEXAI: 'vertexai', COHERE: 'cohere', MISTRALAI: 'mistralai' } };
        else if (specifier.endsWith('/util.js')) exports = { tryParse: JSON.parse };
        else if (specifier === './database.js') exports = { loadSqliteDriver() { throw new Error('unexpected database access'); } };
        else if (specifier === './paths.js') exports = { getStoragePaths() { throw new Error('unexpected file access'); } };
        else throw new Error(`Unexpected import ${specifier}`);
        return new vm.SyntheticModule(Object.keys(exports), function () {
            for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        }, { context });
    });
    await source.evaluate();
    return source.namespace;
}

function clientText(chunks) {
    return chunks.map(String).join('').split(/\r?\n\r?\n/).filter(x => x.startsWith('data:') && !x.includes('[DONE]'))
        .map(x => JSON.parse(x.slice(5))).map(x => x.choices?.[0]?.delta?.content || '').join('');
}

function fragmentedReply(content = reply, ending = 'finish') {
    const args = JSON.stringify({ content });
    const chunks = [event(delta({ tool_calls: [call('', 'emit_complete_')] }))];
    chunks.push(event(delta({ tool_calls: [{ index: 0, function: { name: 'response_test123' } }] })));
    for (let i = 0; i < args.length; i += 3) chunks.push(event(delta({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 3) } }] })));
    if (ending === 'finish') chunks.push(event(delta({}, 'tool_calls')));
    if (ending !== 'eof') chunks.push(event('[DONE]'));
    return chunks.join('');
}

test('eligibility allows only one reply envelope, with varying suffixes and a content schema', async () => {
    const api = await loadBackend();
    const save = { avatar_url: 'test.png', file_name: 'test', kind: 'character' };
    assert.equal(getCompleteResponseToolName(body()), name);
    assert.doesNotThrow(() => api.validateSaveGenerateRequest(save, body()));
    assert.doesNotThrow(() => api.validateSaveGenerateRequest(save, { ...body(), tools: [] }));
    for (const change of [b => b.tools.push(b.tools[0]), b => b.tools[0].function.name = 'search',
        b => b.tools[0].function.parameters.properties.content.type = 'number', b => b.chat_completion_source = 'claude']) {
        const b = body(); change(b);
        assert.equal(getCompleteResponseToolName(b), '');
        assert.throws(() => api.validateSaveGenerateRequest(save, b), /tool/);
    }
});

test('nonstream normalizes client bytes and persisted text without changing upstream tools', async () => {
    const request = body(); request.stream = false;
    const original = structuredClone(request);
    const api = await loadBackend((req, res) => {
        assert.deepEqual(req.body, original);
        res.json(fullReply(reply));
    });
    const job = { generate: request, descriptor: {} };
    const result = await api.runSaveGenerateJob(job);
    assert.equal(job.testSaved, reply);
    assert.deepEqual(request, original);
    const output = JSON.parse(result.response.body);
    assert.equal(output.choices[0].message.content, reply);
    assert.equal(output.choices[0].message.tool_calls, undefined);
    assert.equal(output.choices[0].finish_reason, 'stop');
    let sent;
    api.sendCapturedGenerateResponse({ status() {}, setHeader() {}, get() { return 'application/json'; }, send(data) { sent = data; } }, result.response, job);
    assert.equal(sent.toString(), result.response.bodyText);
});

for (const ending of ['finish', 'done', 'eof']) {
    test(`fragmented SSE tool: ${ending}, UTF-8 and JSON escapes, no duplicate text`, async () => {
        const api = await loadBackend();
        const stream = api.createStreamingState('openai', name);
        const wire = Buffer.from(fragmentedReply(reply, ending).replaceAll('\n\n', '\r\n\r\n').trimEnd());
        const output = [];
        for (const byte of wire) output.push(...stream.push(Buffer.from([byte])));
        output.push(...stream.finish());
        assert.equal(stream.text, reply);
        assert.equal(clientText(output), reply);
        assert.equal(output.map(String).join('').includes('tool_calls'), false);
        assert.equal(stream.canSavePartial, false);
        assert.equal(stream.finish().length, 0);
        const done = stream.takeDoneChunks();
        assert.equal(done.length, ending === 'eof' ? 0 : 1);
    });
}

for (const content of ['plain reply', proxyError]) {
    test(`ordinary text is preserved even when tools were offered: ${content.slice(0, 12)}`, async () => {
        const api = await loadBackend();
        const stream = api.createStreamingState('openai', name);
        const chunks = stream.push(Buffer.from(event(delta({ content })) + event('[DONE]')));
        assert.equal(stream.text, content);
        assert.equal(clientText(chunks), content);
        assert.equal(stream.canSavePartial, true);
        const plain = { choices: [{ message: { content }, finish_reason: 'stop' }] };
        assert.equal(normalizeCompleteResponse(plain, name), plain);
    });
}

for (const scenario of ['wrong-name', 'multiple', 'bad-json', 'missing-content', 'truncated', 'mixed-text', 'content-type', 'second-choice']) {
    test(`invalid tool ${scenario} fails rather than persisting a partial response`, async () => {
        let calls = [call(JSON.stringify({ content: reply }))];
        if (scenario === 'wrong-name') calls[0].function.name = 'execute_something';
        if (scenario === 'multiple') calls.push(call('{}', name, 1));
        if (scenario === 'bad-json') calls[0].function.arguments = '{"content":"unfinished';
        if (scenario === 'missing-content') calls[0].function.arguments = '{}';
        if (scenario === 'content-type') calls[0].function.arguments = '{"content":123}';
        for (const streaming of [false, true]) {
            const data = streaming ? delta({ tool_calls: calls }, scenario === 'truncated' ? 'length' : 'tool_calls')
                : { choices: [{ message: { content: scenario === 'mixed-text' ? 'partial' : null, tool_calls: calls }, finish_reason: scenario === 'truncated' ? 'length' : 'tool_calls' }] };
            if (scenario === 'second-choice') data.choices.unshift(streaming ? { index: 0, delta: { content: 'partial' } } : { message: { content: 'partial' } });
            const api = await loadBackend((_req, res) => {
                if (streaming) {
                    if (scenario === 'mixed-text') res.write(event(delta({ content: 'partial' })));
                    res.end(event(data) + event('[DONE]'));
                } else res.json(data);
            });
            const job = { generate: { ...body(), stream: streaming }, descriptor: {} };
            await assert.rejects(api.runSaveGenerateJob(job), /Invalid complete-response/);
            assert.equal(job.status, 'failed');
            assert.equal(job.testSaved, undefined);
        }
    });
}

test('background capture completes after the client disconnects and withholds DONE until persistence', async () => {
    for (const disconnect of [false, true]) {
        const writes = [];
        let onClose;
        const job = { generate: body(), descriptor: {} };
        const response = { writableEnded: false, headersSent: true, on(_event, fn) { onClose = fn; },
            write(chunk) { writes.push(chunk); if (String(chunk).includes('[DONE]')) assert.equal(job.status, 'completed'); },
            end() { this.writableEnded = true; } };
        const api = await loadBackend((req, res) => {
            assert.equal(req.body.tools[0].function.name, name);
            if (disconnect) onClose();
            res.end(fragmentedReply());
        });
        await api.runSaveGenerateJob(job, { streamResponse: response });
        assert.equal(job.testSaved, reply);
        assert.equal(clientText(writes), disconnect ? '' : reply);
    }
});

test('transport failure cannot turn unfinished tool args into a saved success', async () => {
    const api = await loadBackend((_req, res) => {
        res.write(event(delta({ tool_calls: [call('{"content":"unfinished')] })));
        res.fail(new Error('connection lost'));
    });
    const job = { generate: body(), descriptor: {} };
    await assert.rejects(api.runSaveGenerateJob(job), /connection lost/);
    assert.equal(job.testSaved, undefined);
    assert.equal(job.status, 'failed');
});

test('reasoning is preserved, repeated completion markers do not duplicate content', async () => {
    const api = await loadBackend();
    const stream = api.createStreamingState('openai', name);
    const output = stream.push(Buffer.from(event(delta({ reasoning_content: 'reasoning' }))
        + fragmentedReply() + event(delta({}, 'stop'))));
    assert.equal(stream.reasoning, 'reasoning');
    assert.equal(stream.text, reply);
    assert.equal(clientText(output), reply);
});

test('a second call in a later chunk is rejected even after a valid first call', async () => {
    const api = await loadBackend();
    for (const next of [{ index: 1, function: { arguments: '{}' } }, { index: 0, id: 'another', function: { arguments: '{}' } }]) {
        const stream = api.createStreamingState('openai', name);
        stream.push(Buffer.from(event(delta({ tool_calls: [{ ...call('{'), id: 'first' }] }))));
        assert.throws(() => stream.push(Buffer.from(event(delta({ tool_calls: [next] })))), /additional tool/);
        assert.equal(stream.canSavePartial, false);
    }
});
