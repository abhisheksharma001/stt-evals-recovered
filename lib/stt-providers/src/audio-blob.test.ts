import { describe, expect, it } from "vitest";
import { audioUploadBlob, audioUploadView } from "./audio-blob";

// R-51 (ox-alpha waves, openai.ts). The change these pin is a deletion:
// `new Blob([new Uint8Array(buf)])` became `new Blob([buf])`. The bytes on the
// wire must be identical, and -- the part worth a test -- a Buffer that is a
// view into Node's shared pool must still upload only its own slice.
describe("audioUploadBlob", () => {
  it("carries exactly the bytes it was given", async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255]);
    const blob = audioUploadBlob(bytes);
    expect(blob.size).toBe(bytes.byteLength);
    expect(Buffer.from(await blob.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it("uploads only the slice of a pooled Buffer, not the whole allocation", async () => {
    // Node hands out small Buffers as views into a shared 8KB pool, so
    // `byteOffset` is routinely non-zero and `buffer.byteLength` is much larger
    // than the Buffer. Attaching the pool to an outbound request would leak
    // unrelated memory into a provider POST.
    const pool = Buffer.alloc(64, 7);
    const view = pool.subarray(8, 16);
    view.fill(3);
    expect(view.byteOffset).toBe(8);
    expect(view.buffer.byteLength).toBeGreaterThan(view.byteLength);

    const blob = audioUploadBlob(view);
    expect(blob.size).toBe(8);
    const sent = Buffer.from(await blob.arrayBuffer());
    expect(sent.equals(Buffer.alloc(8, 3))).toBe(true);
  });

  it("produces the same bytes the copying version produced", async () => {
    const bytes = Buffer.from("RIFF....WAVEfmt ", "binary");
    const before = new Blob([new Uint8Array(bytes)]);
    const after = audioUploadBlob(bytes);
    expect(Buffer.from(await after.arrayBuffer()).equals(Buffer.from(await before.arrayBuffer()))).toBe(true);
  });

  it("handles an empty buffer without inventing a byte", async () => {
    expect(audioUploadBlob(Buffer.alloc(0)).size).toBe(0);
  });
  // The whole point of the change: the intermediate Uint8Array is a view over
  // the Buffer's memory, not a second copy of the audio. This is the only
  // assertion that can actually see that, since the Blob constructor copies
  // once no matter what.
  it("views the buffer's memory instead of copying it", () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const view = audioUploadView(bytes);
    expect(view.buffer).toBe(bytes.buffer);
    expect(view.byteOffset).toBe(bytes.byteOffset);
    expect(view.byteLength).toBe(bytes.byteLength);
  });

  it("views only its own slice of a pooled buffer", () => {
    const pool = Buffer.alloc(64, 7);
    const view = audioUploadView(pool.subarray(8, 16));
    expect(view.buffer).toBe(pool.buffer);
    expect(view.byteOffset).toBe(pool.byteOffset + 8);
    expect(view.byteLength).toBe(8);
  });
});
