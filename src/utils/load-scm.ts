import { Readable } from "stream";
import concat from "concat-stream";
import createScmExtractor from "scm-extractor";

/**
 * Extract the embedded `.chk` (StarCraft map definition) from an `.scm`/`.scx`
 * MPQ archive buffer.
 *
 * Original implementation used Node's `Readable.from(buffer)` which is not
 * available in stream-browserify. We build a minimal readable stream manually
 * that pushes the buffer once and then EOF, which scm-extractor consumes just
 * like the native Node.js version.
 */
function readableFromBuffer(buffer: Buffer): Readable {
  let sent = false;
  const r = new Readable({
    read() {
      if (sent) {
        this.push(null);
        return;
      }
      sent = true;
      this.push(buffer);
      this.push(null);
    },
  });
  return r;
}

export default (buffer: Buffer): Promise<Buffer> =>
  new Promise<Buffer>((res, rej) => {
    readableFromBuffer(buffer)
      .pipe(createScmExtractor())
      .on("error", rej)
      .pipe(
        concat((data: Buffer) => {
          res(data);
        }),
      );
  });
