// Only unwrap the reply-envelope tool. This is NOT a general tool executor.
export function getCompleteResponseToolName(body) {
    if (!['openai', 'custom'].includes(body?.chat_completion_source) || body?.tools?.length !== 1) return '';
    const tool = body.tools[0];
    const fn = tool?.function;
    return tool?.type === 'function'
        && /^emit_complete_response(?:_[a-zA-Z0-9]+)?$/.test(fn?.name || '')
        && fn?.parameters?.type === 'object'
        && fn.parameters.properties?.content?.type === 'string'
        && Array.isArray(fn.parameters.required) && fn.parameters.required.includes('content')
        ? fn.name : '';
}

function invalidReply(detail) {
    return Object.assign(new Error(`Invalid complete-response tool reply: ${detail}`), { status: 502 });
}

function readContent(expectedName, name, args) {
    if (name !== expectedName) throw invalidReply('unexpected function name');
    let value;
    try { value = JSON.parse(args); } catch { throw invalidReply('incomplete or malformed arguments'); }
    if (typeof value?.content !== 'string' || !value.content.trim()) throw invalidReply('content must be a non-empty string');
    return value.content;
}

export function normalizeCompleteResponse(data, expectedName) {
    const message = data?.choices?.[0]?.message;
    if (!data?.choices?.some(choice => choice.message?.tool_calls?.length || choice.message?.function_call)) return data;
    const calls = message?.tool_calls;
    if (data.choices.length !== 1 || calls?.length !== 1 || message.function_call
        || (calls[0]?.type && calls[0].type !== 'function')
        || (message.content && (typeof message.content !== 'string' || message.content.trim()))) {
        throw invalidReply('expected one tool call without separate reply text');
    }
    if (data.choices[0].finish_reason === 'length') throw invalidReply('truncated response');
    message.content = readContent(expectedName, calls[0]?.function?.name, calls[0]?.function?.arguments);
    delete message.tool_calls;
    data.choices[0].finish_reason = 'stop';
    return data;
}

export function createCompleteResponseStream(expectedName) {
    let name = '';
    let args = '';
    let callId = '';
    let hasPlainText = false;
    let started = false;
    let completed = false;
    const finish = () => {
        if (!started || completed) return null;
        const content = readContent(expectedName, name, args);
        completed = true;
        return { choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] };
    };
    return {
        get started() { return started; },
        finish,
        push(data) {
            const choices = data?.choices || [];
            if (choices.some(choice => {
                const part = choice.delta ?? choice.message;
                return part?.tool_calls?.length || part?.function_call;
            })) started = true;
            if (started && (choices.length > 1 || choices.some(choice => (choice.index ?? 0) !== 0))) {
                throw invalidReply('unexpected additional choice');
            }
            const choice = choices[0];
            const delta = choice?.delta ?? choice?.message;
            if (!delta) {
                if (started && choice?.finish_reason) {
                    if (choice.finish_reason === 'length') throw invalidReply('truncated response');
                    const final = finish();
                    choice.delta = final?.choices[0].delta || {};
                    choice.finish_reason = 'stop';
                }
                return data;
            }
            const calls = delta.tool_calls;
            if (calls?.length || delta.function_call) {
                started = true;
                if (completed || data.choices.length !== 1 || calls?.length !== 1 || delta.function_call) {
                    throw invalidReply('expected exactly one tool call');
                }
                const call = calls[0] || {};
                if ((call.index ?? 0) !== 0 || (call.type && call.type !== 'function')
                    || (callId && call.id && call.id !== callId)) throw invalidReply('unexpected additional tool call');
                callId ||= call.id || '';
                if (call.function?.name !== undefined) {
                    if (typeof call.function.name !== 'string') throw invalidReply('invalid function name');
                    name += call.function.name;
                }
                if (call.function?.arguments !== undefined) {
                    if (typeof call.function.arguments !== 'string') throw invalidReply('invalid arguments');
                    args += call.function.arguments;
                }
                delete delta.tool_calls;
            }
            hasPlainText ||= Boolean(delta.content && (typeof delta.content !== 'string' || delta.content.trim()));
            if (started && hasPlainText) throw invalidReply('mixed tool and separate reply text');
            if (started && choice.finish_reason) {
                if (choice.finish_reason === 'length') throw invalidReply('truncated response');
                const final = finish();
                if (final) delta.content = final.choices[0].delta.content;
                choice.finish_reason = 'stop';
            }
            return data;
        },
    };
}
