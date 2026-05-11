'use strict';
/**
 * cache.js — Lightweight LRU cache with TTL support.
 *
 * Uses a Map (insertion-order) for O(1) LRU eviction:
 *   - get: deletes and re-inserts the entry to move it to "most recent"
 *   - set: if at capacity, deletes the first (oldest) entry
 */

class LRUCache {
    /**
     * @param {number} maxSize  Maximum number of entries (default 100)
     * @param {number} ttlMs    Time-to-live in milliseconds (default 60 000)
     */
    constructor(maxSize = 100, ttlMs = 60000) {
        this._maxSize = maxSize;
        this._ttlMs   = ttlMs;
        this._map     = new Map(); // key → { value, ts }
    }

    /**
     * Retrieve a value by key.
     * Returns undefined on miss or if the entry has expired.
     * Moves a cache-hit entry to "most recently used".
     * @param {string} key
     * @returns {*}
     */
    get(key) {
        const entry = this._map.get(key);
        if (!entry) return undefined;
        if (Date.now() - entry.ts > this._ttlMs) {
            this._map.delete(key);
            return undefined;
        }
        // Move to most-recent position
        this._map.delete(key);
        this._map.set(key, entry);
        return entry.value;
    }

    /**
     * Store a value.  Evicts the least-recently-used entry when at capacity.
     * @param {string} key
     * @param {*}      value
     */
    set(key, value) {
        if (this._map.has(key)) {
            this._map.delete(key);
        } else if (this._map.size >= this._maxSize) {
            // Delete the oldest entry (first key in insertion order)
            this._map.delete(this._map.keys().next().value);
        }
        this._map.set(key, { value, ts: Date.now() });
    }

    /**
     * Returns true when the key exists and has not expired.
     * @param {string} key
     * @returns {boolean}
     */
    has(key) {
        return this.get(key) !== undefined;
    }

    /** Remove all entries. */
    clear() {
        this._map.clear();
    }

    /** Number of entries currently stored (includes potentially-expired entries). */
    get size() {
        return this._map.size;
    }
}

module.exports = { LRUCache };
