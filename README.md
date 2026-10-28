# LearnPulse Education Intelligence

LearnPulse turns section marks into clear actions for faculty and students. It extends the supplied dark charcoal and muted-orange dashboard with section-scoped course management, persistent browser data, RAG-style retrieval from course resources, and optional detailed reviews through Groq.

The app opens on a student/faculty sign-in screen connected to Supabase email/password authentication. Users must have the trusted `app_metadata.role` set to `student` or `faculty`; the role selector on the sign-in screen does not grant account permissions. **Explore the demo workspace** remains available and does not authenticate.

`.env.example` includes placeholders for Supabase configuration. The browser client uses only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (or `VITE_SUPABASE_PUBLISHABLE_KEY`). Never put `SUPABASE_SECRET_KEY` or a `service_role` key in a `VITE_*` variable or browser code. Assign roles through a trusted administrator/server process, not user-editable metadata. Authenticated course sections, rosters, marks, and materials are loaded from and saved to Supabase. The demo workspace remains browser-local.

## Supabase data setup

The project database initially had no public tables. Apply [`supabase/migrations/20261027000000_learnpulse_data.sql`](./supabase/migrations/20261027000000_learnpulse_data.sql) once in the Supabase Dashboard's SQL Editor. It creates the normalized course/roster/marks/material tables, enables Row Level Security, and adds a transactional save function. The app will report a REST/schema error until this migration has been applied.

For each faculty account, set the trusted `app_metadata.role` to `faculty` using a server-side Supabase Admin API call (never `user_metadata`). Create a faculty section from the app; ownership is tied to that authenticated user. For each student account, set `app_metadata.role` to `student`, add the student to a section's roster, then link that student's roster record(s) to the Auth user UUID in the SQL Editor:

```sql
update public.students
set auth_user_id = 'AUTH_USER_UUID'
where roll_no = 'STUDENT_ROLL_NUMBER';
```

Matching records from different sections may share the same roll number, so this statement links the student across their course sections. Students only receive their own enrollment and marks under the migration's RLS policies; faculty can access only sections they own. Do not expose the Supabase secret key to the browser. Uploaded course material text excerpts are stored in the database; uploaded original files are not.

## What changed

Faculty can create and edit course sections, update section/course/faculty details, import a section's CSV/XLSX marks list, add course materials, monitor cohort and subject performance, and open a detailed individual review. Uploading marks replaces only the currently selected section's roster and marks. Faculty can download section CSV/XLSX, individual marks CSV, and a detailed individual HTML report that can be printed or saved as PDF.

Students choose a section and then a learner from that section's roster. The student view shows the selected section's faculty/course details, personal marks, attendance, class comparison, improvement focus, and materials retrieved from that section's course library. It can also request a Groq study plan based on those marks and resources.

In the demo workspace, course details, rosters, marks, and material metadata are persisted in localStorage. Authenticated account data is read from and written to Supabase instead. The demo identity picker is not authentication or access control.

## Groq setup

The Groq API key is read only by the Node server. It is never put in a `VITE_*` variable, browser bundle, or localStorage. The server sends selected learner marks without the student's name or roll number. It adds course/faculty/section data, cohort and subject averages, and relevant course-resource metadata/snippets as the retrieval context. The server verifies that suggested material IDs exist in the retrieved library.

1. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `.env` to the Supabase project URL and public anon/publishable key.
2. Apply the database migration described above.
3. Set `app_metadata.role` to `student` or `faculty` for each account through a trusted admin process.
4. If using AI reviews, put the key in the server-only `GROQ_API_KEY` setting. Do not commit `.env`.
5. Optionally set `GROQ_MODEL` to another model enabled for the key. The default is `openai/gpt-oss-20b`.
6. Start the app. If no Groq key is configured, marks analytics still work and the AI review shows a clear configuration message.

The app uses Groq's OpenAI-compatible `POST /openai/v1/chat/completions` endpoint and JSON-schema responses. Check Groq's [chat completions reference](https://console.groq.com/docs/api-reference), [supported models](https://console.groq.com/docs/models), and [structured outputs guide](https://console.groq.com/docs/structured-outputs) if you change the model or output schema.

### Course-resource retrieval

Resources belong to the active section. PDF, DOCX, text, Markdown, CSV, and log files are indexed as a short text excerpt (up to 6,000 characters); other uploads are represented by their section, filename, type, subject, and tags. PDF extraction reads up to 12 pages and uploaded files are limited to 20 MB. Resources are selected by subject/topic matching before the Groq request. The app does not upload course files to Groq storage.

## Run locally

Use Node.js 20 or newer and pnpm 10 or newer.

```bash
pnpm install
cp .env.example .env
# Add GROQ_API_KEY in .env if you want AI reviews
pnpm run dev
```

Open `http://localhost:3000`. You can use all numeric analytics and demo flows without a Groq key. Groq review requests require the server to have a valid key and internet access.

## Build and run in production

```bash
pnpm run build
pnpm run start
```

Set `NODE_ENV=production` in the hosting environment. The Node server serves the Vite build and `/api/groq/review` from the same origin. Configure `GROQ_API_KEY`, `GROQ_MODEL` if desired, and `PORT` through the host's secret/environment settings. Do not deploy this as static-only hosting if you need Groq reviews; the server API must be available.

## Privacy and production limits

Do not commit student-identifying production records, API keys, or `.env` files. Use pseudonymous student data in development and follow the institution's student-data policy before using real records. The current implementation has browser-local storage, a demo identity selector, and no authentication, authorization, or shared database; do not use it as a production student records system without those controls.
