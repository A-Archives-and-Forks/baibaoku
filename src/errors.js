export class BaiBaoKuError extends Error {
    constructor(code, message, status = 400, details = undefined) {
        super(message);
        this.name = 'BaiBaoKuError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

export function toHttpError(error) {
    if (error instanceof BaiBaoKuError) {
        return error;
    }

    console.error('[BaiBaoKu] Unexpected error:', error);
    return new BaiBaoKuError('INTERNAL_ERROR', 'Internal BaiBaoKu error.', 500);
}

export function errorPayload(error) {
    return {
        ok: false,
        error: {
            code: error.code,
            message: error.message,
            details: error.details,
        },
    };
}
