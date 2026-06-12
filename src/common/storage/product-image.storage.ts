import { Logger } from '@nestjs/common';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';

const logger = new Logger('ProductImageStorage');

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

/**
 * Upload product images to Firebase Storage when configured. Railway's local
 * filesystem is ephemeral, so durable URLs prevent images from disappearing
 * after a deploy/restart. Local paths remain a development fallback.
 */
export async function persistProductImages(
  files: Express.Multer.File[],
): Promise<string[]> {
  if (files.length === 0) return [];

  const bucketName = getFirebaseBucketName();
  if (!bucketName) {
    return files.map((file) => `/uploads/products/${file.filename}`);
  }

  try {
    ensureFirebaseApp();
    const bucket = getStorage().bucket(bucketName);

    return await Promise.all(
      files.map(async (file) => {
        try {
          const objectName = `products/${Date.now()}-${randomUUID()}-${file.filename}`;
          const downloadToken = randomUUID();

          await bucket.upload(file.path, {
            destination: objectName,
            resumable: false,
            metadata: {
              contentType: file.mimetype,
              cacheControl: 'public,max-age=31536000,immutable',
              metadata: {
                firebaseStorageDownloadTokens: downloadToken,
              },
            },
          });

          await fs.unlink(file.path).catch(() => undefined);
          return (
            `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucketName)}` +
            `/o/${encodeURIComponent(objectName)}?alt=media&token=${downloadToken}`
          );
        } catch (error: any) {
          logger.warn(
            `Firebase upload failed for ${file.filename}; using local fallback: ${error?.message ?? error}`,
          );
          return `/uploads/products/${file.filename}`;
        }
      }),
    );
  } catch (error: any) {
    logger.warn(
      `Firebase Storage upload failed; using local files as fallback: ${error?.message ?? error}`,
    );
    return files.map((file) => `/uploads/products/${file.filename}`);
  }
}
