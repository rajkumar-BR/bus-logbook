// Where bills, photos and documents are kept. Two backends with the same interface:
//   save(folder, fileName, buffer) -> link   stored in the database, e.g. schools/school-001/Bills/Bus 04/2026-10-18 bill.pdf
//   read(link) -> { stream, size } | null    null when the file does not exist
//   url(link)  -> /files/... path the browser asks the app for (the app checks who may open it)
//   init()                                   make sure the folder or bucket is usable
//
//   FILES=local (default)  folders under DATA_DIR
//   FILES=s3               any S3-compatible bucket: Supabase Storage, Cloudflare R2, AWS S3, MinIO.
//                          S3_BUCKET, S3_ENDPOINT (not needed for AWS), S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
//
// A link never changes between backends, so files can be copied across without touching the database.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { clean } from './local-xlsx.js';

const FOLDERS = ['Bills', 'Photos', 'Bus documents'];

// Only these are shown in the browser. Anything else is sent as a download, never rendered.
const TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.heic': 'image/heic', '.pdf': 'application/pdf',
};
export const contentTypeFor = (link) => TYPES[path.extname(link).toLowerCase()] || null;

export function fileUrl(link) {
  if (!link) return '';
  if (/^https?:\/\//.test(link)) return link;
  return '/files/' + link.split('/').map(encodeURIComponent).join('/');
}

// A link is a plain relative path: no empty parts, no dots, no backslashes.
export function isSafeLink(link) {
  return typeof link === 'string' && link.length > 0 && link.length < 400 && !link.includes('\\') && !link.includes('\0')
    && link.split('/').every((part) => part && part !== '.' && part !== '..');
}

// folder may hold several parts (schools/school-001/Bills/Bus 04); each is cleaned.
function targetName(folder, fileName) {
  const safeFolder = folder.split('/').map(clean).filter(Boolean).join('/');
  const ext = path.extname(fileName).toLowerCase();
  const base = clean(path.basename(fileName, path.extname(fileName))) || 'file';
  return { safeFolder, base, ext };
}

function createDiskFiles(root) {
  const resolved = path.resolve(root);
  const exists = (p) => fsp.access(p).then(() => true, () => false);

  return {
    kind: 'local',
    root: resolved,
    async init() {
      for (const f of FOLDERS) await fsp.mkdir(path.join(resolved, f), { recursive: true });
    },
    async save(folder, fileName, buffer) {
      const { safeFolder, base, ext } = targetName(folder, fileName);
      const dir = path.join(resolved, safeFolder);
      await fsp.mkdir(dir, { recursive: true });
      let name = base + ext;
      for (let i = 2; await exists(path.join(dir, name)); i++) name = `${base} (${i})${ext}`;
      await fsp.writeFile(path.join(dir, name), buffer);
      return `${safeFolder}/${name}`;
    },
    async read(link) {
      if (!isSafeLink(link)) return null;
      const file = path.join(resolved, link);
      if (!file.startsWith(resolved + path.sep)) return null;
      try {
        const { size, isFile } = await fsp.stat(file).then((s) => ({ size: s.size, isFile: s.isFile() }));
        return isFile ? { stream: fs.createReadStream(file), size } : null;
      } catch {
        return null;
      }
    },
    url: fileUrl,
  };
}

function createS3Files(env) {
  const bucket = env.S3_BUCKET;
  if (!bucket) throw new Error('FILES=s3 needs S3_BUCKET (and usually S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY).');
  const client = new S3Client({
    region: env.S3_REGION || 'us-east-1',
    endpoint: env.S3_ENDPOINT || undefined,
    forcePathStyle: String(env.S3_FORCE_PATH_STYLE ?? (env.S3_ENDPOINT ? 'true' : 'false')).toLowerCase() === 'true',
    credentials: env.S3_ACCESS_KEY_ID ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } : undefined,
  });
  const missing = (err) => err?.name === 'NoSuchKey' || err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404;

  async function exists(key) {
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (err) {
      if (missing(err)) return false;
      throw err;
    }
  }

  return {
    kind: 's3',
    bucket,
    client,
    async init() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (err) {
        throw new Error(`Cannot open the file bucket "${bucket}" (${err.name}). Check S3_BUCKET, S3_ENDPOINT and the access keys.`);
      }
    },
    async save(folder, fileName, buffer) {
      const { safeFolder, base, ext } = targetName(folder, fileName);
      let name = base + ext;
      for (let i = 2; await exists(`${safeFolder}/${name}`); i++) name = `${base} (${i})${ext}`;
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: `${safeFolder}/${name}`, Body: buffer, ContentType: TYPES[ext] || 'application/octet-stream',
      }));
      return `${safeFolder}/${name}`;
    },
    async read(link) {
      if (!isSafeLink(link)) return null;
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: link }));
        return { stream: out.Body, size: out.ContentLength };
      } catch (err) {
        if (missing(err)) return null;
        throw err;
      }
    },
    url: fileUrl,
  };
}

export function createFiles(env = process.env) {
  const kind = String(env.FILES || 'local').toLowerCase();
  if (kind === 'local') return createDiskFiles(env.DATA_DIR || './data');
  if (kind === 's3') return createS3Files(env);
  throw new Error(`Unknown FILES "${kind}". Use FILES=local or FILES=s3.`);
}
