import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Every uploaded file (vehicle photos, vehicle documents, customer documents) is stored in a private S3
// bucket; the Mongo row only keeps its object key (s3Key). Files are handed out as short-lived
// pre-signed URLs (admin portal) or streamed through the API (car photos on the customer site), so the
// bucket never has to be public.
//
// Files uploaded before S3 was introduced were stored as base64 data URIs on the row itself (`image` /
// `file`). Those are only ever read here, never written — `npm run migrate:s3` moves them into the
// bucket and clears them from Mongo.

const BUCKET = process.env.S3_BUCKET || '';
const REGION = process.env.AWS_REGION || '';
// Optional folder inside the bucket, e.g. 'production' -> production/vehicles/...
const PREFIX = (process.env.S3_PREFIX || '').replace(/^\/+|\/+$/g, '');
const SIGNED_URL_TTL_SECONDS = Number(process.env.S3_SIGNED_URL_TTL_SECONDS) || 60 * 60;

let client = null;
function s3() {
  if (!client) client = new S3Client({ region: REGION });
  return client;
}

export function isS3Configured() {
  return Boolean(BUCKET && REGION);
}

export class StorageNotConfiguredError extends Error {
  constructor() {
    super('File storage is not configured. Please set S3_BUCKET and AWS_REGION on the server.');
    this.status = 503;
    this.expose = true;
  }
}

export function objectKey(...parts) {
  return [PREFIX, ...parts].filter(Boolean).join('/');
}

// Uploads one file (a multer memory-storage file) under `key`. Resolves to the key.
export async function storeFile(file, key) {
  if (!isS3Configured()) throw new StorageNotConfiguredError();
  await s3().send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      // Opened in the browser's own viewer (images / PDFs), never forced to download.
      ContentDisposition: 'inline',
    })
  );
  return key;
}

// URL the admin portal can put straight into <img src> / <iframe src>: a pre-signed S3 URL, or the
// legacy data URI for a row the migration hasn't moved yet.
export async function fileUrl(row, legacyField) {
  if (row?.s3Key) {
    if (!isS3Configured()) return '';
    return getSignedUrl(s3(), new GetObjectCommand({ Bucket: BUCKET, Key: row.s3Key }), { expiresIn: SIGNED_URL_TTL_SECONDS });
  }
  return row?.[legacyField] || '';
}

// Each row as a plain object with `legacyField` (`image` / `file` — the field the admin portal reads)
// set to the file's URL. The S3 key itself is never sent.
export async function withFileUrls(rows, legacyField) {
  return Promise.all(
    rows.map(async (row) => {
      const obj = row.toObject ? row.toObject() : { ...row };
      const url = await fileUrl(obj, legacyField);
      delete obj.s3Key;
      return { ...obj, [legacyField]: url };
    })
  );
}

// The file's bytes, for streaming through the API (customer-site car photos).
// Resolves to { body: Buffer, contentType } or null.
export async function readFile(row, legacyField) {
  if (row?.s3Key) {
    if (!isS3Configured()) return null;
    try {
      const out = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: row.s3Key }));
      return { body: Buffer.from(await out.Body.transformToByteArray()), contentType: out.ContentType || row.mimeType };
    } catch (err) {
      if (err?.name === 'NoSuchKey') return null;
      throw err;
    }
  }
  const match = /^data:([^;]+);base64,(.*)$/s.exec(row?.[legacyField] || '');
  if (!match) return null;
  return { body: Buffer.from(match[2], 'base64'), contentType: row.mimeType || match[1] };
}
