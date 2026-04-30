// Injected into every esbuild pre-bundle (vite optimizeDeps.esbuildOptions.inject).
// Ensures `process` and `Buffer` exist inside bundled Node-style modules such as
// scm-extractor -> readable-stream, bl, and implode-decoder.
import processPolyfill from "process/browser";
import { Buffer as BufferPolyfill } from "buffer";

if (typeof globalThis.process === "undefined") {
  globalThis.process = processPolyfill;
}
if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = BufferPolyfill;
}
