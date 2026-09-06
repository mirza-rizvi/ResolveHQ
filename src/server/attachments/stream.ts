import { base64Url } from "../lib/crypto";
import { HttpError } from "../http/errors";

/** Both sinks are backpressured; no tee branch can accumulate a whole upload. */
export async function storeValidatedUpload(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array>,
  size: number,
  contentType: string,
  attachmentId: string,
  validate: (prefix: Uint8Array, type: string) => boolean,
) {
  const fixed = new FixedLengthStream(size);
  const destination = fixed.writable.getWriter();
  const digest = new crypto.DigestStream("SHA-256");
  const hash = digest.getWriter();
  const reader = body.getReader();
  const prefix = new Uint8Array(Math.min(512, size));
  let copied = 0,
    received = 0;
  const put = bucket.put(key, fixed.readable, { httpMetadata: { contentType }, customMetadata: { attachmentId } });
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > size)
        throw new HttpError(400, "upload_size_mismatch", "The uploaded size does not match the upload intent.");
      const take = Math.min(prefix.length - copied, value.length);
      prefix.set(value.subarray(0, take), copied);
      copied += take;
      await Promise.all([destination.write(value), hash.write(value)]);
    }
    if (received !== size)
      throw new HttpError(400, "upload_size_mismatch", "The uploaded size does not match the upload intent.");
    if (!validate(prefix, contentType))
      throw new HttpError(415, "mime_mismatch", "The file contents do not match its declared type.");
    await Promise.all([destination.close(), hash.close()]);
  })();
  try {
    await Promise.all([put, pump]);
    return base64Url(new Uint8Array(await digest.digest));
  } catch (error) {
    await Promise.allSettled([
      reader.cancel(),
      fixed.readable.cancel(error),
      destination.abort(error),
      hash.abort(error),
      digest.digest,
    ]);
    await Promise.allSettled([put, pump]);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
