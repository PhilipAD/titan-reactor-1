type TypedArray =
    | Int8Array
    | Uint8Array
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint32Array;

// only works for ints presently for std::vector mapping
export class StdVector<T extends TypedArray> {
    protected heap: T;

    address: number;
    #shift = 0;

    constructor( heap: T, address: number ) {
        this.heap = heap;

        if ( heap instanceof Int8Array || heap instanceof Uint8Array ) {
            this.address = address;
            this.#shift = 0;
        } else if ( heap instanceof Int16Array || heap instanceof Uint16Array ) {
            this.address = address >> 1;
            this.#shift = 1;
        } else if ( heap instanceof Int32Array || heap instanceof Uint32Array ) {
            this.address = address >> 2;
            this.#shift = 2;
        } else {
            throw new Error( "Unsupported heap type" );
        }
    }

    get isNull() {
        return this.heap[this.address] === 0;
    }

    get size() {
        const addr = this.heap[this.address];
        const end_addr = this.heap[this.address + 1];

        const stride = 1 << this.#shift;

        if ( !Number.isFinite( addr ) || !Number.isFinite( end_addr ) ) return 0;
        if ( addr === 0 || end_addr === 0 ) return 0;
        if ( end_addr < addr ) return 0;

        const byteSpan = end_addr - addr;
        if ( byteSpan % stride !== 0 ) return 0;

        const count = byteSpan / stride;
        if ( count > 0xfffff ) return 0;
        return count;
    }

    #safeRange() {
        const addr = this.heap[this.address];
        const end_addr = this.heap[this.address + 1];
        const stride = 1 << this.#shift;

        if ( !Number.isFinite( addr ) || !Number.isFinite( end_addr ) ) return null;
        if ( addr === 0 || end_addr === 0 ) return null;
        if ( end_addr < addr ) return null;
        const byteSpan = end_addr - addr;
        if ( byteSpan % stride !== 0 ) return null;
        if ( byteSpan / stride > 0xfffff ) return null;

        const lo = addr >> this.#shift;
        const hi = end_addr >> this.#shift;
        if ( lo < 0 || hi > this.heap.length ) return null;

        return [ lo, hi ] as const;
    }

    copyData() {
        const r = this.#safeRange();
        if ( !r ) return ( this.heap.slice( 0, 0 ) ) as T;
        return this.heap.slice( r[0], r[1] ) as T;
    }

    copyDataShallow() {
        const r = this.#safeRange();
        if ( !r ) return ( this.heap.subarray( 0, 0 ) ) as T;
        return this.heap.subarray( r[0], r[1] ) as T;
    }

    get isEmpty() {
        return this.heap[this.address] === this.heap[this.address + 1];
    }

    *[Symbol.iterator](): IterableIterator<number> {
        const addr = this.heap[this.address];
        const end_addr = this.heap[this.address + 1];
        const stride = 1 << this.#shift;

        if ( !Number.isFinite( addr ) || !Number.isFinite( end_addr ) ) return;
        if ( addr === 0 || end_addr === 0 ) return;
        if ( end_addr < addr ) return;
        const byteSpan = end_addr - addr;
        if ( byteSpan % stride !== 0 ) return;

        const baseIdx = addr >> this.#shift;
        const count = byteSpan / stride;
        const safeCount = count > 0xfffff ? 0 : count;
        const heapLen = this.heap.length;
        for ( let i = 0; i < safeCount; i++ ) {
            const idx = baseIdx + i;
            if ( idx < 0 || idx >= heapLen ) return;
            yield this.heap[idx];
        }
    }
}
