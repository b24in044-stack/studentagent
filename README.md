# LearnPulse

LearnPulse is a student and faculty dashboard that uses Firebase Authentication and Cloud Firestore for identity and data access. The app keeps browser-only configuration in `VITE_FIREBASE_*` variables and server-only secrets such as `GOOGLE_APPLICATION_CREDENTIALS` and `GROQ_API_KEY` on the backend.

## Required environment variables

Create a personal `.env` from `.env.example` and fill in the values from your Firebase project.

```bash
VITE_FIREBASE_API_KEY=your_firebase_web_api_key
VITE_FIREBASE_AUTH_DOMAIN=your_project_id.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your_project_id
VITE_FIREBASE_STORAGE_BUCKET=your_project_id.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=your_messaging_sender_id
VITE_FIREBASE_APP_ID=your_firebase_app_id

GOOGLE_APPLICATION_CREDENTIALS=./secrets/firebase-service-account.json
GROQ_API_KEY=
GROQ_MODEL=openai/gpt-oss-20b
PORT=3000
```

Do not place service-account JSON contents or Firebase private keys in `VITE_*` variables. The browser app should only receive the public web configuration values.

## Firebase setup

1. Create a web app in Firebase Console.
2. Open Project settings > General > Your apps and copy the web config values.
3. Enable Email/Password authentication in Authentication > Sign-in method.
4. Create Firestore. The checked-in `firestore.rules` denies direct browser access to application documents. Authenticated application requests go through Express, which verifies Firebase ID tokens and enforces UID-based roles and section membership with the Admin SDK.
5. Configure server-side Firebase Admin credentials using Application Default Credentials or `GOOGLE_APPLICATION_CREDENTIALS`. The server also uses `FIREBASE_PROJECT_ID`, `GCLOUD_PROJECT`, or `VITE_FIREBASE_PROJECT_ID` to select the project; it must match the web app project.

## Student registration and profile provisioning

The browser creates the account with Firebase Authentication, then sends its Firebase ID token to `POST /api/auth/register-profile`. The Express server verifies the token with Firebase Admin and creates `users/{uid}` with the `student` role and `students/{uid}` in one idempotent Firestore transaction. Session restoration and sign-in use `GET /api/auth/profile` to verify the trusted server-side profile. If the canonical role document is absent, sign-in keeps the account out of protected routes and offers Student profile recovery; it provisions with a fresh ID token and verifies the profile before opening the dashboard. Existing faculty or unsupported role data cannot be converted by public registration. The browser never assigns roles or writes these records. A failed profile setup is shown in the registration page and can be retried without creating another Auth account. Faculty roles must be provisioned by a trusted administrator; public registration cannot set them.

Registration API responses use JSON for success, validation, authentication, and server errors. If Firebase Authentication creates an account but profile setup fails, retry from the registration screen. If the browser session has ended, sign in with that same account; when its Student profile is missing, LearnPulse returns the signed-in user to profile setup recovery rather than attempting to create another Auth account.

## Course-section access

The browser does not read or write `courseSections` directly. It calls authenticated Express endpoints, and the server verifies the ID token and trusted role stored in `users/{uid}` on each request. Faculty access is limited to assigned sections and subject assignments; Students access only sections whose server-maintained `enrolledStudentUids` array contains their Firebase Auth UID, with their linked profile verified before access. Faculty can update marks and attendance only for already-enrolled students and their authorized subjects. Enrollment, class structure, and subjects are managed by an Admin; faculty cannot replace a roster or assign new students.

The Student dashboard requires no client-side course data to render. A successful empty `GET /api/course-sections` response shows the enrollment empty state; API or Firestore failures show their error and a retry action. An Admin assigns a Student to a class from College Management; public registration creates an unassigned pending student profile and never invents academic details.

The rules intentionally deny client SDK access to `users`, `students`, `courseSections`, and all other collections because application data access is mediated by the authenticated backend (Admin SDK access bypasses Firestore rules). Deploy only after reviewing and approving the rules:

```bash
firebase deploy --only firestore:rules --project studentagent-6a19a
```

Existing sections without `assignedFacultyUid` or `enrolledStudentUids` are not automatically migrated or exposed by the new endpoints. A trusted administrator must review and backfill any such records before they become accessible through the application.

## Admin-only Faculty Management

Public registration remains Student-only. The browser never writes roles or creates Faculty/Admin accounts. Every Admin API verifies a Firebase ID token (including revocation status), then checks the caller's active `users/{uid}.role == "admin"` in Firestore. Student and Faculty accounts cannot call Admin APIs; Admin accounts do not gain Faculty course access.

### One-time first Admin setup

1. Create the intended administrator in Firebase Authentication using the trusted Firebase Console workflow and verify that account's email.
2. Obtain that account's Firebase Auth UID from the Console. Run the following in a trusted server/operations environment with the existing Firebase Admin Application Default Credentials or `GOOGLE_APPLICATION_CREDENTIALS` configured for the correct project. Do not put a service-account key in the browser or commit it.

```powershell
$env:ADMIN_BOOTSTRAP_UID = "AUTH_UID_FROM_FIREBASE_CONSOLE"
$env:ADMIN_BOOTSTRAP_EMAIL = "VERIFIED_ADMIN_EMAIL"
$env:ADMIN_BOOTSTRAP_CONFIRM = "CREATE_FIRST_LEARNPULSE_ADMIN"
npm run bootstrap:admin
Remove-Item Env:\ADMIN_BOOTSTRAP_UID, Env:\ADMIN_BOOTSTRAP_EMAIL, Env:\ADMIN_BOOTSTRAP_CONFIRM
```

The script has no HTTP endpoint. It refuses to run if an Admin already exists or its one-time Firestore marker `system/adminBootstrap` exists. It grants the Admin role to only the explicitly supplied, existing, email-verified Firebase account and records the UID in that marker. Review the chosen UID/project before running. Do not run this as part of normal application startup. Additional administrator changes require a separate trusted server-side Firebase Admin operation; there is no public Admin-role editor.

### Faculty account and profile model

- `users/{uid}` remains the trusted authorization document and stores `uid`, `role: "faculty"`, `status: "active" | "inactive"`, and the account's name, email, employee ID, and department.
- `faculty/{uid}` stores the editable Faculty profile with the same Firebase UID as both document ID and `authUserId`.
- `facultyEmployeeIds/{lowercase-employee-id}` is a server-only uniqueness index pointing to the faculty UID.
- Existing course assignments remain on `courseSections/{sectionId}.assignedFacultyUid`; Admin assignment updates that field. Existing Faculty section reads/writes remain restricted to the assigned UID.
- No temporary password is written to Firestore, returned to the browser, or logged. The account is initially disabled while its profile is created, then enabled. If provisioning fails, the backend attempts to remove the Auth account and any newly-created profile/index documents; incomplete cleanup returns an explicit error for administrator review.

Sign in through the existing Login page using the Admin account's Firebase email and password. The server-loaded trusted role opens the Admin-only Faculty Management page; selecting a role in the login UI does not grant authorization. Public `/register` continues to provision Students only.

In Faculty Management, an Admin can create a Faculty account with a temporary password, edit name/email/employee ID/department, activate or deactivate access, search the directory, and assign/unassign existing course sections. Deliver the temporary password out-of-band through a secure channel; Faculty can use the existing password-reset link to set their own password. Deactivation updates both Firestore status and Firebase Auth's disabled state. All course assignments continue to be checked against server-side `assignedFacultyUid`.

No additional environment variable is required for normal application operation. First Admin bootstrap temporarily uses `ADMIN_BOOTSTRAP_UID`, `ADMIN_BOOTSTRAP_EMAIL`, and `ADMIN_BOOTSTRAP_CONFIRM` in the trusted operator's process environment. The existing Firebase Admin credentials and project selection variables remain server-only.

## Protected workspace modules

The authenticated workspace uses browser-history routes and role-specific navigation:

| Route | Student | Faculty |
| --- | --- | --- |
| `/` | Overview | Command-center overview |
| `/profile` | Authenticated Student profile fields | Authenticated account and assigned workload |
| `/courses` | Authorized course library | Course and section management |
| `/attendance` | Own recorded attendance | Assigned-section attendance entry |
| `/timetable` | Not configured | — |
| `/subjects` | — | Subjects listed on assigned sections |
| `/monitoring` | — | Assigned-section student management |
| `/marks` | — | Marks import and section results |
| `/assignments` | Not configured | Not configured |
| `/materials` | Authorized material metadata/excerpts | Assigned-section material management |
| `/examinations` | Not configured | — |
| `/results` | Own recorded subject marks | — |
| `/performance` | Own performance and attendance analytics | Assigned-section performance monitor |
| `/learning-signals` | Own evidence-based insights | Authorized section/student AI reviews |
| `/ai-assistant` | Structured Groq learning review | — |
| `/notifications`, `/settings` | Not configured | Not configured |

Unauthenticated users are redirected to `/login`; role-incompatible routes redirect to the role's overview. Each data-backed module distinguishes loading, empty results, and API errors. Performance values and learning signals are omitted when source marks or attendance are absent. Groq review context is assembled on the backend from Firestore only after trusted section and student authorization; browser-supplied marks/context are not trusted. New course materials use private Firebase Storage objects, a 10 MB limit, an educational-format allowlist, and authenticated download endpoints. Older metadata-only materials remain non-downloadable.

## College academic management

The Admin-only College Management page extends the existing schema without migrating or deleting current records. It manages `departments`, `academicYears`, `subjects`, class metadata in `courseSections`, UID-keyed Student profiles, and normalized student-ID uniqueness records in `studentIds`. Student academic assignments are written only after an administrator chooses an active department, year, semester, and class. Newly-created class assignments update the relevant profile, trusted role record, roster, and enrollment UID in one Firestore transaction.

Faculty configure assessment records in `assessments`, save marks in `assessmentMarks`, and corrections append records to `assessmentMarkAudit`. The assessments UI is connected to faculty Marks & Grades and student Results. Weighted grades are withheld until required assessments and the full weightage are present. College reports still summarize the legacy marks and attendance embedded in `courseSections`; they do not yet aggregate the new normalized assessment marks.

Set `FIREBASE_STORAGE_BUCKET` on the server to the bucket used by Firebase Storage (the example value is also present in `VITE_FIREBASE_STORAGE_BUCKET`). The server uploads files as private objects and never returns Storage URLs. `storage.rules` denies browser SDK reads and writes; the backend Admin SDK is the authorized access path. Faculty can upload and remove files for assigned sections; students can download only through the authenticated endpoint after their enrollment is verified. Storage must be enabled in the Firebase project before file operations can succeed. No rules were deployed.

No live Firestore or Storage operations, schema migrations, Firebase rules deployment, or test-account writes are performed by local tests. The checked-in `firestore.rules` denies browser SDK reads and writes; the Express Admin SDK is the only application data path. Re-review and explicitly approve rules before deploying any rules changes.

The current backend does not provide timetable, examination, assignment/submission, notification, editable profile, or portal-settings data. Their protected navigation destinations explicitly explain that missing backend support instead of displaying invented academic information. Faculty attendance entry uses the existing authorized course-section update endpoint and stores the currently modeled attendance percentage per student.

## Local development

```bash
npm install
cp .env.example .env
npm run dev
```

The app runs on `http://localhost:3000` by default.

The development server serves both Express and Vite on that origin. If running Vite separately, its `/api` requests are proxied to the Express server at `http://127.0.0.1:$PORT`; set the server-only `API_PROXY_TARGET` variable to override that target. Keep the Express server running. In production, route `/api/*` to Express rather than the static Vite host so API errors remain JSON instead of falling through to the frontend HTML.

## Production build

```bash
npm run build
npm run start
```

The server verifies Firebase Admin credentials before enabling protected routes. If credentials are missing, the app will still start but protected backend checks remain unavailable until the environment is configured.

## Notes

- The frontend uses Firebase Auth and Firestore, not Supabase Auth or PostgreSQL.
- The Express server handles Groq review calls and optional Firebase Admin initialization.
- Keep `.env` out of source control and never commit service-account credentials.
