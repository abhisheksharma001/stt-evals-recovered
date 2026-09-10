/** R-51 (ox-alpha waves, openai.ts): the four upload adapters each built their
 *  multipart part as `new Blob([new Uint8Array(input.audioBytes)])`.
 *
 *  `audioBytes` is a `Buffer`, and a Buffer *is* a Uint8Array, so
 *  `new Uint8Array(buffer)` is not a view -- it copies every byte. The Blob
 *  constructor then copies them again into its own storage. Two full copies of
 *  a call recording, per cell, times PROVIDER_CONCURRENCY. Only one of them is
 *  unavoidable.
 *
 *  The obvious fix the register suggested -- `new Blob([buffer])` -- does not
 *  compile here, and that is worth writing down rather than rediscovering:
 *  `BlobPart` wants `Uint8Array<ArrayBuffer>`, while Node types a Buffer as
 *  `Buffer<ArrayBufferLike>`, which TypeScript cannot prove is not
 *  SharedArrayBuffer-backed. So the copy was doing double duty as a type
 *  workaround, and deleting it outright is not an option.
 *
 *  A view over the same memory satisfies both. The cast is the one assertion
 *  TypeScript cannot make for itself; nothing in this package produces a
 *  SharedArrayBuffer-backed Buffer, the audio arrives from the filesystem or
 *  from fetch, and a Blob would read it correctly either way. */
export function audioUploadView(audioBytes: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    audioBytes.buffer as ArrayBuffer,
    audioBytes.byteOffset,
    audioBytes.byteLength,
  );
}

/** The multipart body part for an audio upload. One copy, not two. */
export function audioUploadBlob(audioBytes: Buffer): Blob {
  return new Blob([audioUploadView(audioBytes)]);
}
