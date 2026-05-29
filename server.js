const express = require('express');
const cors = require('cors');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY;
const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 50;
// ─── Utilities ─────────────────────────────────────────────────────────────
function stripHtml(html) {
return html
.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
.replace(/<[^>]+>/g, ' ')
.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
.replace(/\s+/g, ' ').trim();
}
function chunkText(text, sourceName) {
const words = text.split(' ').filter(w => w.length > 0);
const chunks = [];
let i = 0;
while (i < words.length) {
const content = words.slice(i, i + CHUNK_SIZE).join(' ');
if (content.length > 100) chunks.push({ content, metadata: { source: sourceName, chunkIndex: chunks.length } });
i += CHUNK_SIZE - CHUNK_OVERLAP;
}
return chunks;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function getEmbedding(text, inputType = 'document') {

const response = await fetch('https://api.anthropic.com/v1/embeddings', {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
body: JSON.stringify({ model: 'voyage-3', input: text, input_type: inputType })
});
const data = await response.json();
if (data.error) throw new Error(`Embedding error: ${data.error.message}`);
return data.embeddings[0].embedding;
}
async function storeChunk(chunk, embedding) {
const response = await fetch(`${SUPABASE_URL}/rest/v1/documents`, {
method: 'POST',
headers: {
'Content-Type': 'application/json',
'apikey': SUPABASE_SECRET_KEY,
'Authorization': `Bearer ${SUPABASE_SECRET_KEY}`,
'Prefer': 'return=minimal'
},
body: JSON.stringify({ content: chunk.content, metadata: chunk.metadata, embedding })
});
if (!response.ok) throw new Error(`Supabase store error: ${await response.text()}`);
}
async function searchHandbook(embedding) {
const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_documents`, {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${SUPABASE_SECRET_KEY}` },
body: JSON.stringify({ query_embedding: embedding, match_threshold: 0.5, match_count: 5 })
});
return await response.json();
}
async function ingestChunks(chunks, progressCallback) {
let stored = 0;
for (let i = 0; i < chunks.length; i++) {
const embedding = await getEmbedding(chunks[i].content);
await storeChunk(chunks[i], embedding);
stored++;
if (progressCallback) progressCallback(i + 1, chunks.length);
await sleep(200);
}
return stored;
}
// ─── Chat endpoint ─────────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
const { messages } = req.body;
if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Invalid request' });
try {
const question = messages[messages.length - 1].content;
const history = messages.slice(0, -1);
const embedding = await getEmbedding(question, 'query');
const chunks = await searchHandbook(embedding);
const context = Array.isArray(chunks) && chunks.length > 0
? chunks.map((c, i) => `[Section ${i + 1}${c.metadata?.source ? ' — ' + c.metadata.source : ''}]\n${c.content}`).join('\n\n')
: 'No relevant handbook sections found.';
const system = `You are an expert assistant for the Santa Clara County Medi-Cal Handbook (DEBS).
Answer using ONLY the handbook sections below. If the answer isn't there, say so and direct to: https://stgenssa.sccgov.org/debs/program_handbooks/medi-cal/index.htm
Always mention which section your answer is from. Be clear and professional. Use bullet points for lists.
--- RELEVANT HANDBOOK SECTIONS ---
${context}
--- END ---`;
const response = await fetch('https://api.anthropic.com/v1/messages', {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
body: JSON.stringify({
model: 'claude-haiku-4-5-20251001',
max_tokens: 1000,
system,
messages: [...history.slice(-6), { role: 'user', content: question }]
})
});
const data = await response.json();
if (data.error) throw new Error(data.error.message);
res.json({ reply: data.content[0].text, chunksFound: Array.isArray(chunks) ? chunks.length : 0 });
} catch (err) {
console.error('Chat error:', err.message);
res.status(500).json({ error: err.message });
}
});
// ─── Admin: ingest URL ─────────────────────────────────────────────────────
app.post('/api/admin/ingest-url', async (req, res) => {
const { adminKey, url, name } = req.body;

if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
try {
const response = await fetch(url);
const html = await response.text();
const text = stripHtml(html);
const chunks = chunkText(text, name || url);
const stored = await ingestChunks(chunks);
res.json({ success: true, chunks: stored, source: name || url });
} catch (err) {
res.status(500).json({ error: err.message });
}
});
// ─── Admin: ingest plain text ──────────────────────────────────────────────
app.post('/api/admin/ingest-text', async (req, res) => {
const { adminKey, text, name } = req.body;
if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
try {
const chunks = chunkText(text, name || 'Manual Text');
const stored = await ingestChunks(chunks);
res.json({ success: true, chunks: stored, source: name });
} catch (err) {
res.status(500).json({ error: err.message });
}
});
// ─── Admin: ingest PDF ─────────────────────────────────────────────────────
app.post('/api/admin/ingest-pdf', upload.single('pdf'), async (req, res) => {
if (req.body.adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
try {
const pdfParse = require('pdf-parse');
const data = await pdfParse(req.file.buffer);
const chunks = chunkText(data.text, req.body.name || req.file.originalname);
const stored = await ingestChunks(chunks);
res.json({ success: true, chunks: stored, source: req.body.name || req.file.originalname });
} catch (err) {
res.status(500).json({ error: err.message });
}
});
// ─── Admin: list documents ─────────────────────────────────────────────────

app.post('/api/admin/list', async (req, res) => {
const { adminKey } = req.body;
if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
try {
const response = await fetch(`${SUPABASE_URL}/rest/v1/documents?select=id,metadata&order=id.asc`, {
headers: { 'apikey': SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${SUPABASE_SECRET_KEY}` }
});
const docs = await response.json();
// Group by source
const sources = {};
docs.forEach(d => {
const src = d.metadata?.source || 'Unknown';
sources[src] = (sources[src] || 0) + 1;
});
res.json({ total: docs.length, sources });
} catch (err) {
res.status(500).json({ error: err.message });
}
});
// ─── Admin: delete source ──────────────────────────────────────────────────
app.post('/api/admin/delete-source', async (req, res) => {
const { adminKey, source } = req.body;
if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
try {
const response = await fetch(
`${SUPABASE_URL}/rest/v1/documents?metadata->>source=eq.${encodeURIComponent(source)}`,
{
method: 'DELETE',
headers: { 'apikey': SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${SUPABASE_SECRET_KEY}` }
}
);
res.json({ success: response.ok });
} catch (err) {
res.status(500).json({ error: err.message });
}
});
// ─── Health check ──────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
res.json({ status: 'ok', supabase: !!SUPABASE_URL, anthropic: !!ANTHROPIC_API_KEY });

});
app.get('*', (req, res) => {
res.sendFile('index.html', { root: 'public' });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
