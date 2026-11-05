// Sando (ShrineTech): read a workspace 3D model into the browser through IFileService (SANDO-VIEWER3D.md).
// There is no HTTP file route in the web workbench: every file the browser sees comes over the RPC channel, which works the
// same for desktop, web and remote workspaces. readFileRange returns a top-level Uint8Array (the raw-bytes RPC path, no
// base64) clamped by the service to 1 MB, so the model is read in 1 MB windows, a few in flight at a time.
import { MODEL3D_MAX_BYTES } from "./model3dSpec.js";

export interface Model3dFileReader {
  stat(params: { path: string }): Promise<{ type: "file" | "directory"; size?: number }>;
  readFileRange(params: { path: string; offset: number; length: number }): Promise<Uint8Array>;
}

export class Model3dReadError extends Error {
  constructor(
    message: string,
    readonly code: "not_file" | "too_large" | "empty" | "aborted",
  ) {
    super(message);
    this.name = "Model3dReadError";
  }
}

const CHUNK = 1024 * 1024;
const IN_FLIGHT = 4;

/** Reads `[offset, offset+length)` fully, even if the service hands back shorter chunks than asked for. */
async function readSpan(
  reader: Model3dFileReader,
  path: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let got = 0;
  while (got < length) {
    const part = await reader.readFileRange({ path, offset: offset + got, length: length - got });
    if (!part.byteLength) break; // truncated while reading: return what is there, the loader decides
    out.set(part.subarray(0, length - got), got);
    got += part.byteLength;
  }
  return got === length ? out : out.subarray(0, got);
}

/** The whole file as an ArrayBuffer. `onProgress(read, total)`; total is 0 when an old remote stat has no size. */
export async function readModel3dFile(
  reader: Model3dFileReader,
  path: string,
  {
    signal,
    onProgress,
    maxBytes = MODEL3D_MAX_BYTES,
  }: {
    signal?: AbortSignal;
    onProgress?: (read: number, total: number) => void;
    maxBytes?: number;
  } = {},
): Promise<ArrayBuffer> {
  const aborted = () => {
    if (signal?.aborted) throw new Model3dReadError("aborted", "aborted");
  };
  const st = await reader.stat({ path });
  aborted();
  if (st.type !== "file") throw new Model3dReadError("not a file", "not_file");
  const size = typeof st.size === "number" && Number.isFinite(st.size) ? st.size : null;
  if (size !== null && size > maxBytes)
    throw new Model3dReadError("file too large to view", "too_large");
  if (size === 0) throw new Model3dReadError("the file is empty", "empty");

  if (size === null) {
    // Old remote without a size: read sequentially until the service returns nothing.
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      aborted();
      const part = await reader.readFileRange({ path, offset: total, length: CHUNK });
      if (!part.byteLength) break;
      parts.push(part);
      total += part.byteLength;
      if (total > maxBytes) throw new Model3dReadError("file too large to view", "too_large");
      onProgress?.(total, 0);
    }
    if (!total) throw new Model3dReadError("the file is empty", "empty");
    const all = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.byteLength;
    }
    return all.buffer;
  }

  const all = new Uint8Array(size);
  let read = 0;
  let next = 0;
  let end = size;
  const worker = async () => {
    while (next < end) {
      aborted();
      const offset = next;
      const length = Math.min(CHUNK, end - offset);
      next += length;
      const part = await readSpan(reader, path, offset, length);
      all.set(part, offset);
      read += part.byteLength;
      if (part.byteLength < length) end = Math.min(end, offset + part.byteLength);
      onProgress?.(read, size);
    }
  };
  await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, Math.ceil(size / CHUNK)) }, worker));
  aborted();
  return end === size ? all.buffer : all.slice(0, end).buffer;
}
