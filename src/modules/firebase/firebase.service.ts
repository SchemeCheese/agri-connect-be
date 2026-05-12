import { Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import * as admin from 'firebase-admin';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);

  onModuleInit() {
    // Avoid re-initializing if another module already did so (e.g. in tests)
    if (admin.apps.length > 0) {
      this.logger.log('Firebase Admin SDK already initialized — reusing existing app.');
      return;
    }

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    // Cloud Run / Railway store the private key with literal \n — replace them
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      this.logger.warn(
        'Firebase Admin SDK credentials are missing. ' +
          'Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY ' +
          'to enable Firebase token verification.',
      );
      return;
    }

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });

    this.logger.log(`Firebase Admin SDK initialized for project "${projectId}".`);
  }

  /**
   * Verifies a Firebase ID token issued by the client SDK.
   *
   * @param idToken  The raw Firebase ID token from the Authorization header.
   * @returns        The decoded token payload (uid, email, name, picture, …).
   * @throws         UnauthorizedException when the token is invalid or expired.
   */
  async verifyIdToken(idToken: string): Promise<admin.auth.DecodedIdToken> {
    if (admin.apps.length === 0) {
      throw new UnauthorizedException(
        'Firebase Admin SDK is not initialised. Check server environment variables.',
      );
    }

    try {
      const decoded = await admin.auth().verifyIdToken(idToken, /* checkRevoked */ true);
      return decoded;
    } catch (err: any) {
      this.logger.warn(`Firebase token verification failed: ${err?.message ?? err}`);
      throw new UnauthorizedException('Firebase ID token không hợp lệ hoặc đã hết hạn.');
    }
  }
}
