# Chat History - Google Auth Role Changes

Date: 2026-05-13

Summary of the final implementation for Google register/login with role selection and toast feedback.

Changes:

- `BE/agri-connect-be/src/modules/auth/dto/auth.dto.ts`
  - Added Google auth DTOs with explicit role validation using a local `GoogleAuthRole` enum.

- `BE/agri-connect-be/src/modules/auth/dtos/firebase-login.dto.ts`
  - Updated the Firebase login DTO to carry a selected Google role instead of the old boolean role flags.

- `BE/agri-connect-be/src/modules/auth/google-auth.service.ts`
  - Implemented role-aware Google auth using Firebase ID token verification.
  - Register flow now creates or updates the existing user record with the chosen role.
  - Login flow now validates the requested role and returns a JWT only when the role is already enabled.

- `BE/agri-connect-be/src/modules/auth/google-auth.controller.ts`
  - Exposed `POST /auth/google/register` and `POST /auth/google/login` for the frontend to call.

- `FE/agri-ecommerce1/src/context/AuthContext.tsx`
  - Replaced redirect-based Google handling with popup-based auth.
  - Added explicit `loginWithGoogle(role)` and `registerWithGoogle(role)` methods so pages can show toasts before navigation.

- `FE/agri-ecommerce1/src/app/(auth)/login/page.tsx`
  - Google login now uses the selected role, shows success/failure toasts, and redirects to the main page after success.

- `FE/agri-ecommerce1/src/app/(auth)/register/page.tsx`
  - Google register now uses the selected role, shows success/failure toasts, and redirects back to the login page after success.

- `BE/agri-connect-be/src/database/database.service.ts`
  - Kept the existing Prisma client lifecycle but made the connection setup compatible with the project’s config-driven runtime.

- `BE/agri-connect-be/src/database/database.module.ts`
  - Imported `ConfigModule` so `DatabaseService` can resolve environment-based database settings.

Why:

- The existing app already uses a single user record with buyer/seller flags, so the safest way to support the requested flow was to keep that model and make Google auth role-aware instead of forcing a schema migration across the whole codebase.
- Popup-based auth lets the frontend own toasts and redirects cleanly, which is required for the UX the user asked for.
- The backend now returns clear failure reasons when a user tries to log in with a role that is not registered yet.

What changed in behavior:

- Google register succeeds only for the selected role and returns the user to the login page.
- Google login succeeds only when the selected role already exists for that account and returns the user to the main page.
- If the role is missing, the backend returns an explicit error message that the frontend displays in a toast.

Note:

- No Prisma schema migration was required for the final solution because the role support was implemented on top of the existing user flags.

If you want, the next step is to run the backend and frontend locally, verify the Google popup flow, and then push the backend commit for Railway.
