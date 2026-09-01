export interface StoredObject {
  body: ReadableStream;
  contentType: string;
  size: number;
  etag?: string;
}

export interface PutObjectInput {
  key: string;
  body: ReadableStream | ArrayBuffer;
  contentType: string;
  metadata?: Record<string, string>;
}

export interface StorageProvider {
  put(input: PutObjectInput): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}

export class R2StorageProvider implements StorageProvider {
  constructor(private readonly bucket: R2Bucket) {}

  async put(input: PutObjectInput) {
    await this.bucket.put(input.key, input.body, {
      httpMetadata: { contentType: input.contentType },
      customMetadata: input.metadata,
    });
  }

  async get(key: string): Promise<StoredObject | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return {
      body: object.body,
      contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
      size: object.size,
      etag: object.etag,
    };
  }

  async delete(key: string) {
    await this.bucket.delete(key);
  }
}
