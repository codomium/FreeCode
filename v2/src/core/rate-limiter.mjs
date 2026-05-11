/**
 * Rate Limiter — handle 429 and 529 API responses.
 *
 * Implements exponential backoff with jitter for rate-limited
 * and overloaded API responses. Tracks retry state per-instance.
 *
 * v4.2-B: Added CircuitBreaker class per provider.
 */

/**
 * CircuitBreaker — prevents cascading failures per provider (v4.2-B).
 *
 * States: CLOSED → OPEN (after 3 failures) → HALF_OPEN (after cooldown)
 *
 * - CLOSED:    requests flow normally
 * - OPEN:      requests are rejected immediately (fallback to other providers)
 * - HALF_OPEN: one probe request allowed; success → CLOSED, failure → OPEN
 */
export class CircuitBreaker {
    /**
     * @param {object} [options]
     * @param {number} [options.failureThreshold=3]  - failures to trip OPEN
     * @param {number} [options.cooldownMs=30000]    - ms before HALF_OPEN probe
     */
    constructor(options = {}) {
        this.failureThreshold = options.failureThreshold ?? 3;
        this.cooldownMs       = options.cooldownMs       ?? 30_000;
        this._failures        = 0;
        this._state           = 'CLOSED'; // 'CLOSED' | 'OPEN' | 'HALF_OPEN'
        this._openedAt        = null;
    }

    /**
     * Check whether a request should be allowed through.
     * @returns {{ allowed: boolean, state: string }}
     */
    allowRequest() {
        if (this._state === 'CLOSED') return { allowed: true,  state: 'CLOSED' };
        if (this._state === 'OPEN') {
            if (Date.now() - this._openedAt >= this.cooldownMs) {
                this._state = 'HALF_OPEN';
                return { allowed: true, state: 'HALF_OPEN' };
            }
            return { allowed: false, state: 'OPEN' };
        }
        // HALF_OPEN: allow the probe
        return { allowed: true, state: 'HALF_OPEN' };
    }

    /**
     * Record a successful API response.
     */
    recordSuccess() {
        this._failures = 0;
        this._state    = 'CLOSED';
        this._openedAt = null;
    }

    /**
     * Record a failed API response.
     * @param {number} [statusCode] - HTTP status (429 = transient, 402/403 = auth/quota)
     */
    recordFailure(statusCode) {
        // 402/403 are non-transient — don't increment failure count
        if (statusCode === 402 || statusCode === 403) return;

        this._failures++;
        if (this._failures >= this.failureThreshold) {
            this._state    = 'OPEN';
            this._openedAt = Date.now();
        }
    }

    /**
     * Get current breaker status.
     */
    status() {
        return {
            state:            this._state,
            failures:         this._failures,
            failureThreshold: this.failureThreshold,
            openedAt:         this._openedAt,
            remainingCooldownMs: this._state === 'OPEN'
                ? Math.max(0, this.cooldownMs - (Date.now() - this._openedAt))
                : 0,
        };
    }

    /**
     * Manually reset the breaker to CLOSED state.
     */
    reset() {
        this._failures = 0;
        this._state    = 'CLOSED';
        this._openedAt = null;
    }
}

export class RateLimiter {
    /**
     * @param {object} [options]
     * @param {number} [options.maxRetries] - max number of retries (default: 5)
     * @param {number} [options.baseDelay] - base delay in ms (default: 1000)
     * @param {number} [options.maxDelay] - max delay in ms (default: 60000)
     */
    constructor(options = {}) {
        this.maxRetries = options.maxRetries ?? 5;
        this.baseDelay = options.baseDelay ?? 1000;
        this.maxDelay = options.maxDelay ?? 60000;
        this.retryAfter = 0;
        this.retryCount = 0;
        this.lastRetryAt = null;
    }

    /**
     * Handle an API response and determine whether to retry.
     * @param {{ status: number, headers: { get: (name: string) => string|null } }} response
     * @returns {Promise<'ok'|'retry'|'fail'>}
     */
    async handleResponse(response) {
        if (response.status === 429) {
            // Rate limited
            if (this.retryCount >= this.maxRetries) return 'fail';

            const retryAfter = parseInt(response.headers?.get?.('retry-after') || '10', 10);
            const delayMs = Math.min(retryAfter * 1000, this.maxDelay);
            this.retryAfter = Date.now() + delayMs;
            this.retryCount++;
            this.lastRetryAt = new Date().toISOString();

            await this.wait(delayMs);
            return 'retry';
        }

        if (response.status === 529) {
            // API overloaded
            if (this.retryCount >= this.maxRetries) return 'fail';

            const delay = this.calculateBackoff();
            this.retryAfter = Date.now() + delay;
            this.retryCount++;
            this.lastRetryAt = new Date().toISOString();

            await this.wait(delay);
            return 'retry';
        }

        if (response.status === 502 || response.status === 503 || response.status === 504) {
            // Bad Gateway / Service Unavailable / Gateway Timeout — transient server-side errors
            if (this.retryCount >= this.maxRetries) return 'fail';

            const delay = this.calculateBackoff();
            this.retryAfter = Date.now() + delay;
            this.retryCount++;
            this.lastRetryAt = new Date().toISOString();

            await this.wait(delay);
            return 'retry';
        }

        // Success — reset retry count
        this.retryCount = 0;
        return 'ok';
    }

    /**
     * Calculate exponential backoff with jitter.
     * @returns {number} delay in milliseconds
     */
    calculateBackoff() {
        const exponential = this.baseDelay * Math.pow(2, this.retryCount);
        const jitter = Math.random() * this.baseDelay;
        return Math.min(exponential + jitter, this.maxDelay);
    }

    /**
     * Check if we should wait before making a request.
     * @returns {boolean}
     */
    shouldWait() {
        return Date.now() < this.retryAfter;
    }

    /**
     * Get remaining wait time in ms.
     * @returns {number}
     */
    remainingWait() {
        return Math.max(0, this.retryAfter - Date.now());
    }

    /**
     * Reset all retry state.
     */
    reset() {
        this.retryAfter = 0;
        this.retryCount = 0;
        this.lastRetryAt = null;
    }

    /**
     * Get current limiter status.
     */
    status() {
        return {
            retryCount: this.retryCount,
            maxRetries: this.maxRetries,
            retryAfter: this.retryAfter,
            lastRetryAt: this.lastRetryAt,
            isWaiting: this.shouldWait(),
            remainingMs: this.remainingWait(),
        };
    }

    /**
     * Wait for the specified duration.
     * @param {number} ms
     * @returns {Promise<void>}
     */
    wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
