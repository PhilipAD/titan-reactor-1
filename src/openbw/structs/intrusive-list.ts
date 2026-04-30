/**
 * Represents an openbw intrusive_list.
 *
 * Hermes 2026-04 spawn-anything pass: previously this captured the
 * `openBW.HEAPU32` Uint32Array via WeakRef once at construction, which
 * goes stale the first time WASM memory grows (Emscripten 5.x detaches
 * the old ArrayBuffer and allocates a fresh one). Now we accept either
 * a typed-array (legacy callers, kept stable for tests) OR a
 * "heap getter" thunk that returns the LIVE heap on each iteration.
 * The bridge / scene-composer always pass the thunk so they stay
 * grow-safe.
 */
export type HeapGetter = () => Uint32Array;

const isHeapGetter = ( h: Uint32Array | HeapGetter ): h is HeapGetter =>
    typeof h === "function";

export class IntrusiveList {
    private _heapGetter: HeapGetter;
    private _pairOffset: number;
    private _current = 0;
    addr: number;

    get #heap() {
        return this._heapGetter();
    }

    constructor( heap: Uint32Array | HeapGetter, addr = 0, pairOffset = 0 ) {
        if ( isHeapGetter( heap ) ) {
            this._heapGetter = heap;
        } else {
            // Legacy: store a static thunk pointing at the snapshot.
            // Callers that pass a thunk get the live heap; callers that
            // pass a typed-array get the original behavior (good for
            // tests / non-WASM environments).
            const snapshot = heap;
            this._heapGetter = () => snapshot;
        }
        this.addr = addr;
        this._pairOffset = pairOffset;
    }

    *[Symbol.iterator]() {
        const heap = this.#heap;
        if ( !heap ) return;

        const end = heap[this.addr >> 2];
        const begin = heap[( this.addr >> 2 ) + 1];
        if (
            !end ||
            !begin ||
            ( end >> 2 ) >= heap.length ||
            ( begin >> 2 ) >= heap.length ||
            heap[end >> 2] === end
        ) {
            return;
        }

        const seen = new Set< number >();
        const maxNodes = 8192;
        this._current = begin;
        for ( let i = 0; i < maxNodes && this._current !== end; i++ ) {
            if (
                !this._current ||
                ( this._current >> 2 ) >= heap.length ||
                seen.has( this._current )
            ) {
                return;
            }
            seen.add( this._current );
            yield this._current;
            const nextIndex = ( this._current >> 2 ) + this._pairOffset + 1;
            if ( nextIndex < 0 || nextIndex >= heap.length ) return;
            this._current = heap[nextIndex];
        }
    }

    *reverse() {
        const heap = this.#heap;
        if ( !heap ) return;

        const end = heap[( this.addr >> 2 ) + 1];
        const begin = heap[this.addr >> 2];

        if (
            !end ||
            !begin ||
            ( end >> 2 ) >= heap.length ||
            ( begin >> 2 ) >= heap.length ||
            heap[end >> 2] === end
        ) {
            return;
        }

        const seen = new Set< number >();
        const maxNodes = 8192;
        this._current = begin;
        for ( let i = 0; i < maxNodes && this._current !== end; i++ ) {
            if (
                !this._current ||
                ( this._current >> 2 ) >= heap.length ||
                seen.has( this._current )
            ) {
                return;
            }
            seen.add( this._current );
            yield this._current;
            const nextIndex = ( this._current >> 2 ) + this._pairOffset;
            if ( nextIndex < 0 || nextIndex >= heap.length ) return;
            this._current = heap[nextIndex];
        }
    }

    /**
     * Hermes 2026-04 spawn-anything pass:
     *
     * The legacy `[Symbol.iterator]()` and `reverse()` above use the
     * VALUE stored at the sentinel slot as the loop terminator
     * (`end = heap[(addr>>2)+0]`), which is the LAST real node address
     * rather than the actual sentinel terminator. As a result the
     * iterator terminates ONE NODE TOO EARLY -- it never yields the
     * tail (forward) / head (reverse) when the list contains real
     * nodes.
     *
     * walk()/walkReverse() are the corrected versions. They use a
     * unified terminator that handles BOTH layouts found in OpenBW:
     *
     *   1. SELF-REFERENCING SENTINEL (pairOffset = 0):
     *      The list head IS the link itself (sprite.images,
     *      sprite-on-tile lines). tail.next = sentinelAddr.
     *      => terminator = sentinelAddr (= this.addr - 0).
     *
     *   2. PHANTOM-UNIT SENTINEL (pairOffset > 0, e.g. 43 for unit_t):
     *      The list head is a 2-pointer cell, but the link inside each
     *      node sits at a non-zero byte offset (172 = 4*43 for unit_t).
     *      OpenBW treats the sentinel as if it were a fake node whose
     *      link lives at offset 172 of a struct that starts 172 bytes
     *      BEFORE the sentinel cell. So tail.next = sentinelAddr - 172.
     *      => terminator = sentinelAddr - 4*pairOffset.
     *
     * Both cases collapse to: `terminator = this.addr - 4*pairOffset`.
     *
     * Without this fix the per-player units iterator skips the TAIL of
     * each player's unit list, which for Hermes is the FIRST unit
     * spawned via `_create_completed_unit_at` (typically the Command
     * Center, since spawns push to the front). The skipped CC then
     * never gets registered into `unitQuadtree`, never gets linked to
     * its main image via `images.setUnit()`, and the user can SEE the
     * CC sprite but cannot CLICK it.
     */
    *walk() {
        const heap = this.#heap;
        if ( !heap ) return;

        const terminator = this.addr - 4 * this._pairOffset;
        const begin = heap[( this.addr >> 2 ) + 1];
        if (
            !begin ||
            ( begin >> 2 ) >= heap.length ||
            begin === terminator
        ) {
            return;
        }

        const seen = new Set< number >();
        const maxNodes = 8192;
        this._current = begin;
        for ( let i = 0; i < maxNodes && this._current !== terminator; i++ ) {
            if (
                !this._current ||
                ( this._current >> 2 ) >= heap.length ||
                seen.has( this._current )
            ) {
                return;
            }
            seen.add( this._current );
            yield this._current;
            const nextIndex = ( this._current >> 2 ) + this._pairOffset + 1;
            if ( nextIndex < 0 || nextIndex >= heap.length ) return;
            this._current = heap[nextIndex];
        }
    }

    *walkReverse() {
        const heap = this.#heap;
        if ( !heap ) return;

        const terminator = this.addr - 4 * this._pairOffset;
        const begin = heap[this.addr >> 2];
        if (
            !begin ||
            ( begin >> 2 ) >= heap.length ||
            begin === terminator
        ) {
            return;
        }

        const seen = new Set< number >();
        const maxNodes = 8192;
        this._current = begin;
        for ( let i = 0; i < maxNodes && this._current !== terminator; i++ ) {
            if (
                !this._current ||
                ( this._current >> 2 ) >= heap.length ||
                seen.has( this._current )
            ) {
                return;
            }
            seen.add( this._current );
            yield this._current;
            const nextIndex = ( this._current >> 2 ) + this._pairOffset;
            if ( nextIndex < 0 || nextIndex >= heap.length ) return;
            this._current = heap[nextIndex];
        }
    }
}
