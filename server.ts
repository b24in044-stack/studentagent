import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createViteServer } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const isProduction = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
const model = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const server = createHttpServer(app);
app.disable('x-powered-by');
app.use(express.json({ limit: '96kb' }));

const windows = new Map<string, { count: number; startedAt: number }>();
app.use('/api/groq', (req, res, next) => {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const window = windows.get(key);
  if (!window || now - window.startedAt > 60_000) windows.set(key, { count: 1, startedAt: now });
  else if (window.count >= 12) return res.status(429).json({ error: 'Review limit reached. Please try again in a minute.' });
  else window.count += 1;
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, groqConfigured: Boolean(process.env.GROQ_API_KEY), model });
});

app.post('/api/groq/review', async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Groq is not configured yet. Set GROQ_API_KEY on the server and restart LearnPulse.' });
  const context = req.body?.context;
  if (!context || typeof context !== 'object' || !context.course || !context.learner || !context.cohort || !Array.isArray(context.retrievedMaterials)) {
    return res.status(400).json({ error: 'Review context is incomplete. Refresh the section and try again.' });
  }
  const materialIds = new Set<string>(context.retrievedMaterials.map((item: { id?: unknown }) => typeof item.id === 'string' ? item.id : '').filter(Boolean));
  const reviewSchema = {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      strengths: { type: 'array', items: { type: 'string' } },
      focusAreas: { type: 'array', items: { type: 'object', properties: { subject: { type: 'string' }, evidence: { type: 'string' }, action: { type: 'string' } }, required: ['subject', 'evidence', 'action'], additionalProperties: false } },
      weeklyPlan: { type: 'array', items: { type: 'string' } },
      recommendedMaterials: { type: 'array', items: { type: 'object', properties: { materialId: { type: 'string' }, reason: { type: 'string' } }, required: ['materialId', 'reason'], additionalProperties: false } },
      facultyFollowUp: { type: 'string' },
    },
    required: ['summary', 'strengths', 'focusAreas', 'weeklyPlan', 'recommendedMaterials', 'facultyFollowUp'],
    additionalProperties: false,
  };

  try {
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_completion_tokens: 1100,
        response_format: { type: 'json_schema', json_schema: { name: 'learnpulse_review', strict: true, schema: reviewSchema } },
        messages: [
          {
            role: 'system',
            content: 'You are a careful academic learning coach. Use only the supplied course data, marks, comparisons, and retrieved materials. Do not infer diagnoses, character traits, or causes that are not in evidence. Give kind, specific, age-neutral, actionable study advice. Do not fabricate resources; recommendedMaterials must use only supplied material IDs. Mention numerical evidence accurately. Return a complete review, with 3 to 5 short weekly plan steps and no more than 4 materials. If no resource is relevant, return an empty recommendedMaterials array. Keep the wording human and supportive.',
          },
          { role: 'user', content: JSON.stringify(context) },
        ],
      }),
    });
    if (!groqResponse.ok) {
      const providerMessage = groqResponse.status === 401 ? 'Groq rejected the server key. Check GROQ_API_KEY.' : groqResponse.status === 429 ? 'Groq rate limit reached. Try again shortly.' : `Groq returned an error (${groqResponse.status}).`;
      return res.status(groqResponse.status === 429 ? 429 : 502).json({ error: providerMessage });
    }
    const body = await groqResponse.json() as { choices?: { message?: { content?: string } }[]; model?: string };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return res.status(502).json({ error: 'Groq returned an empty review. Please try again.' });
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const stringArray = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 7) : [];
    const focusAreas = Array.isArray(parsed.focusAreas) ? parsed.focusAreas.slice(0, 5).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const area = item as Record<string, unknown>;
      return typeof area.subject === 'string' && typeof area.evidence === 'string' && typeof area.action === 'string'
        ? [{ subject: area.subject.slice(0, 100), evidence: area.evidence.slice(0, 500), action: area.action.slice(0, 500) }]
        : [];
    }) : [];
    const recommendedMaterials = Array.isArray(parsed.recommendedMaterials) ? parsed.recommendedMaterials.slice(0, 4).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const suggestion = item as Record<string, unknown>;
      return typeof suggestion.materialId === 'string' && materialIds.has(suggestion.materialId) && typeof suggestion.reason === 'string'
        ? [{ materialId: suggestion.materialId, reason: suggestion.reason.slice(0, 350) }]
        : [];
    }) : [];
    const review = {
      summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 1200) : 'Review the score evidence and focus on the lowest-mark subjects first.',
      strengths: stringArray(parsed.strengths),
      focusAreas,
      weeklyPlan: stringArray(parsed.weeklyPlan).slice(0, 5),
      recommendedMaterials,
      facultyFollowUp: typeof parsed.facultyFollowUp === 'string' ? parsed.facultyFollowUp.slice(0, 600) : 'Discuss the next study step with the learner.',
      model: body.model || model,
    };
    return res.json({ review });
  } catch (error) {
    console.error('Groq review failed:', error instanceof Error ? error.message : 'Unknown error');
    return res.status(502).json({ error: 'Could not complete the Groq review. Check the server connection and try again.' });
  }
});

if (isProduction) {
  app.use(express.static(path.join(root, 'dist')));
  app.use((_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
} else {
  const vite = await createViteServer({
    configFile: path.join(root, 'vite.config.ts'),
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => console.log(`LearnPulse listening on http://0.0.0.0:${port}`));
