# LearnPulse Education Intelligence — Implementation Plan

## Scope

Extend the supplied React/Vite LearnPulse app into a faculty and student course-performance portal backed by Groq for detailed, evidence-grounded feedback. Preserve the existing dark charcoal and muted-orange visual language, seeded demo content, and responsive layouts.

The Faculty Portal must let faculty choose or create sections, maintain course/faculty details, upload and replace section-specific marks, add learning materials, monitor student/class/subject performance, request detailed Groq reviews, and download section or individual marks/reports. The Student Portal must limit the displayed roster to the chosen section and show its faculty/course information, marks, attendance, comparison, improvement steps, and section material recommendations.

## Product flow

1. Load demo sections on first use and persist edits, uploaded marks, course details, and resources in local browser storage so changes survive a refresh on that browser.
2. A faculty member chooses or creates a section. Section details and uploaded roster/marks belong only to that section. CSV/XLSX imports replace the active section's roster and subject list and recalculate analytics.
3. Faculty can edit course/section metadata and add course resources with subject/topic tags. Resource metadata and readable text snippets are included in the retrieval context.
4. Faculty monitor section averages, subject averages, student performance groups, attendance alerts, and individual reports. The interface can download section CSV/XLSX and individual marks/review data.
5. A student chooses a section and a student from that section's roster. Only that section's matching marks, course, faculty, materials, and advice are shown.
6. The browser computes numeric comparisons locally. `src/lib/rag.ts` builds a section/student context from course/faculty details, class statistics, individual marks, topics, and relevant course resources. The server sends that context to Groq for faculty/student feedback, never exposing the API key to the browser.

## Technical approach

- **Frontend:** existing React 19 + TypeScript + Vite application.
- **Backend:** small Node/Express server serves the built frontend and provides `/api/health` and `/api/groq/review`; Vite dev middleware is mounted by the same server for local development.
- **Groq:** server-only `GROQ_API_KEY` and optional `GROQ_MODEL` configuration; use Groq's OpenAI-compatible chat-completions API with JSON mode and a configurable model default. Validate requests and responses and return clear configuration/provider errors.
- **State:** seeded sections plus validated localStorage persistence for browser-local course, roster, marks, and material changes. This MVP is not multi-user storage or authentication.
- **RAG:** deterministic retrieval of relevant subject/topic resources plus course/faculty/section metadata and mark-derived evidence. Include material snippets for readable text/Markdown/CSV uploads; keep non-text file metadata available for retrieval. The generated feedback must not invent a course material or a mark.
- **Reports:** retain section CSV/XLSX export and detailed per-student HTML report. Add direct individual marks CSV export and include available AI guidance in report downloads.
- **Privacy:** never place Groq credentials in Vite `VITE_*` variables or browser storage. Do not send student name/roll number to Groq; send only section/course evidence and the selected learner's marks.

## Design direction

- **Design movement:** editorial academic command center with premium dark mode.
- **Core principles:** calm hierarchy, evidence before decoration, role-aware actions, fast scanning on phones.
- **Color philosophy:** charcoal reduces visual noise; orange is reserved for decisions, alerts, and active progress; sage/green confirms healthy performance.
- **Layout paradigm:** a left rail on desktop becomes a compact top bar on mobile; content uses stacked evidence cards rather than dense admin grids.
- **Signature elements:** orange rule markers, student identity chips, and signal cards pairing a metric with an interpretation.
- **Interaction philosophy:** every action returns visible evidence: upload status, selected section, filter counts, saved course changes, and explainable recommendations.
- **Animation:** restrained 150–220ms fades and lift on interactive cards; no distracting motion during data review.
- **Typography:** geometric display face for headings, neutral sans for content, mono for labels and statuses.
- **Brand essence:** LearnPulse turns course marks into clear next actions for faculty and students; focused, trustworthy, practical.
- **Brand voice:** “See the signal behind every mark.” / “Turn the next weak topic into the next win.”
- **Wordmark:** LearnPulse with a small pulse-line mark inside the “P”.
- **Signature color:** muted orange `#ff8c32`.

## Project structure

```text
learnpulse/
├── plan.md
├── TODO.md
├── README.md
├── package.json
├── server.ts                 # Express API, Groq proxy, Vite dev middleware, production static serving
├── .env.example              # Server-only Groq configuration template
├── public/
│   ├── learnpulse-mark.svg
│   └── manus-routes.json
└── src/
    ├── main.tsx
    ├── App.tsx               # Faculty/student workflows and reports
    ├── styles.css            # Existing visual system plus course/AI states
    └── lib/
        ├── types.ts          # Course, roster, material, and AI contracts
        ├── demoData.ts       # First-run sample sections
        ├── analytics.ts      # Deterministic marks/statistics
        ├── rag.ts            # Retrieval context assembly and material matching
        └── groq.ts           # Typed browser request to the same-origin review API
```

## Delivery boundary

Deliver the updated runnable source project and setup guidance. Groq reviews require the user to set `GROQ_API_KEY` on the server; no API key is included. Local browser persistence is single-browser storage, not authenticated multi-user or institutional production storage. Numeric analytics remain deterministic and must be checked alongside AI-generated suggestions.
