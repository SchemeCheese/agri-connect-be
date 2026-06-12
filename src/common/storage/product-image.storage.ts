import { Logger } from '@nestjs/common';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';

const logger = new Logger('ImageStorage');
const DATA_IMAGE_REGEX = /^data:image\/(?:jpeg|png|webp|gif);base64,/i;
const MAX_DATA_IMAGE_LENGTH = Math.ceil((5 * 1024 * 1024 * 4) / 3) + 100;
type FirebaseBucket = ReturnType<ReturnType<typeof getStorage>['bucket']>;

function getFirebaseBucketName() {
  return (
    process.env.FIREBASE_STORAGE_BUCKET ||
    (process.env.FIREBASE_PROJECT_ID
      ? `${process.env.FIREBASE_PROJECT_ID}.firebasestorage.app`
      : '')
  );
}

function ensureFirebaseApp() {
  if (getApps().length > 0) return;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Firebase Admin credentials are incomplete.');
  }

  initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
}

let firebaseBucketPromise: Promise<FirebaseBucket | null> | null = null;

async function getFirebaseBucket(): Promise<FirebaseBucket | null> {
  if (firebaseBucketPromise) return firebaseBucketPromise;

  firebaseBucketPromise = (async () => {
    const bucketName = getFirebaseBucketName();
    if (!bucketName) return null;

    try {
      ensureFirebaseApp();
      const bucket = getStorage().bucket(bucketName);
      const [exists] = await bucket.exists();
      if (!exists) {
        logger.warn(
          `Firebase bucket ${bucketName} does not exist; storing uploaded images in PostgreSQL.`,
        );
        return null;
      }
      return bucket;
    } catch (error: any) {
      logger.warn(
        `Firebase Storage is unavailable; storing uploaded images in PostgreSQL: ${error?.message ?? error}`,
      );
      return null;
    }
  })();

  return firebaseBucketPromise;
}

async function fileToDataUrl(file: Express.Multer.File): Promise<string> {
  const bytes = file.buffer ?? (file.path ? await fs.readFile(file.path) : null);
  if (!bytes) throw new Error(`Cannot read uploaded image ${file.originalname}.`);

  if (file.path) await fs.unlink(file.path).catch(() => undefined);
  return `data:${file.mimetype};base64,${bytes.toString('base64')}`;
}

async function persistImages(
  files: Express.Multer.File[],
  folder: 'products' | 'chat',
): Promise<string[]> {
  if (files.length === 0) return [];

  const bucket = await getFirebaseBucket();
  if (!bucket) {
    return Promise.all(files.map(fileToDataUrl));
  }

  return Promise.all(
    files.map(async (file) => {
      try {
        const objectName = `${folder}/${Date.now()}-${randomUUID()}-${file.filename || file.originalname}`;
        const downloadToken = randomUUID();
        const metadata = {
          contentType: file.mimetype,
          cacheControl: 'public,max-age=31536000,immutable',
          metadata: { firebaseStorageDownloadTokens: downloadToken },
        };

        if (file.path) {
          await bucket.upload(file.path, {
            destination: objectName,
            resumable: false,
            metadata,
          });
          await fs.unlink(file.path).catch(() => undefined);
        } else if (file.buffer) {
          await bucket.file(objectName).save(file.buffer, {
            resumable: false,
            metadata,
          });
        } else {
          throw new Error('Uploaded file has neither path nor buffer.');
        }

        return (
          `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket.name)}` +
          `/o/${encodeURIComponent(objectName)}?alt=media&token=${downloadToken}`
        );
      } catch (error: any) {
        logger.warn(
          `Firebase upload failed for ${file.originalname}; storing it in PostgreSQL: ${error?.message ?? error}`,
        );
        return fileToDataUrl(file);
      }
    }),
  );
}

/**
 * Firebase is preferred when a bucket exists. PostgreSQL data URLs are the
 * durable fallback because Railway's local filesystem is ephemeral.
 */
export async function persistProductImages(
  files: Express.Multer.File[],
): Promise<string[]> {
  return persistImages(files, 'products');
}

export async function persistChatImage(file: Express.Multer.File): Promise<string> {
  const [url] = await persistImages([file], 'chat');
  return url;
}

export function isManagedChatImageUrl(url: string): boolean {
  if (url.startsWith('/uploads/chat/')) return true;
  if (url.length <= MAX_DATA_IMAGE_LENGTH && DATA_IMAGE_REGEX.test(url)) return true;

  const bucketName = getFirebaseBucketName();
  if (!bucketName) return false;
  const prefix =
    `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucketName)}` +
    `/o/${encodeURIComponent('chat/')}`;
  return url.startsWith(prefix);
}
