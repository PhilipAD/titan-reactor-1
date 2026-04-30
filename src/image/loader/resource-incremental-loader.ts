import { ResourceLoader } from "./resource-loader";

function concatenateArrayBuffers(arrayBuffers: ArrayBuffer[]) {
    const totalLength = arrayBuffers.reduce(
        (acc, arrayBuffer) => acc + arrayBuffer.byteLength,
        0
    );

    const result = new Uint8Array(totalLength);

    let offset = 0;
    for (let arrayBuffer of arrayBuffers) {
        result.set(new Uint8Array(arrayBuffer), offset);
        offset += arrayBuffer.byteLength;
    }

    return Buffer.from(result);
}

export class ResourceIncrementalLoader extends ResourceLoader {
    chunkSize = 512* 1024;
    resourceSize = 0;
    #buffers: ArrayBuffer[] = [];
    start = 0;
    end = 0;
    #abortController: AbortController | null = null;

    override async fetch() {
        try {
            this.status = "loading";
            this.buffer = null;
            const buffer = await this.cache?.getValue(this.key);
            if (buffer) {
                this.buffer = buffer;
                this.status = "loaded";
                return this.buffer;
            }
            this.#abortController = new AbortController();
            const headers = await fetch(this.url, {
                method: "HEAD",
                signal: this.#abortController.signal,
            }).then((res) => res.headers);
            if (headers.get("Content-Length") === null) {
                throw new Error("no content length");
            }
            const size = Number(headers.get("Content-Length")!);
            // Guard against broken / CASC-miss responses: NaN, negatives, or
            // obviously bogus sizes (>512 MB). Without this the concatenation
            // step tries to allocate an absurd Uint8Array and throws
            // "Array buffer allocation failed", which in MapScene bubbles up
            // and kills the whole map load.
            if (!Number.isFinite(size) || size <= 0 || size > 512 * 1024 * 1024) {
                throw new Error(`resource size out of range: ${size} (${this.url})`);
            }
            this.resourceSize = size;
            this.#buffers.length = 0;
            this.start = 0;
            // 2026 fix: HTTP Range "bytes=N-M" is INCLUSIVE on both ends, so
            // a chunk of size `chunkSize` runs from `start` to
            // `start + chunkSize - 1`. Previously we set `end = start + chunkSize`
            // which made every chunk request return one EXTRA byte, the next
            // chunk started at that overlapping byte, and concatenation
            // duplicated one byte per chunk boundary. That shifted every byte
            // after the first 512 KB by N (where N = chunk index), corrupting
            // the offsets that loadAnimAtlas reads to slice teamcolor /
            // emissive / etc. DDS layers — which then triggered
            // "THREE.DDSLoader.parse: Invalid magic number in DDS header"
            // and made buildings & large units render as blank meshes.
            this.end = Math.min(this.start + this.chunkSize - 1, this.resourceSize - 1);
            return this.#fetchChunk(this.start, this.end);
        } catch (e) {
            if ((e as Error).name === "AbortError") {
                this.status = "cancelled";
            } else {
                console.error(e);
                this.status = "error";
            }
            return null;
        }
    }

    async #fetchChunk(start: number, end: number): Promise<Buffer | null> {
        try {
            const buffer = await fetch(this.url, {
                headers: {
                    Range: `bytes=${start}-${end}`,
                },
                signal: this.#abortController?.signal,
            }).then((res) => res.arrayBuffer());

            if (buffer.byteLength === 0) {
                throw new Error("empty buffer");
            }

            this.#buffers.push(buffer);

            // Move past the LAST byte we just received (Range end is
            // inclusive). With the inclusive-Range fix in fetch(), this gives
            // a clean concat with no duplicate / no missing bytes.
            this.start = end + 1;
            this.end = Math.min(this.start + this.chunkSize - 1, this.resourceSize - 1);

            if (this.start >= this.resourceSize) {
                this.buffer = concatenateArrayBuffers(this.#buffers);
                this.#buffers.length = 0;
                await this.cache?.setValue({ id: this.key, buffer: this.buffer.buffer });
                this.status = "loaded";
                return this.buffer;
            } else {
                return this.#fetchChunk(this.start, this.end);
            }
        } catch (e) {
            if ((e as Error).name === "AbortError") {
                this.status = "cancelled";
            } else {
                console.error(e);
                this.status = "error";
            }
            return null;
        }
    }
}
