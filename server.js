const express = require('express');
const cors = require('cors');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY;
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;

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

function chunkText(text, sourceName, handbook = '') {
  const words = text.split(' ').filter(w => w.length > 0);
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    const content = words.slice(i, i + CHUNK_SIZE).join(' ');
    if (content.length > 100) chunks.push({
      content,
      metadata: { source: sourceName, handbook, chunkIndex: chunks.length }
    });
    i += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function authCheck(req, res) {
  if (req.body?.adminKey !== ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ─── Supabase helpers ──────────────────────────────────────────────────────

function supabaseHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SECRET_KEY,
    'Authorization': `Bearer ${SUPABASE_SECRET_KEY}`,
    ...extra
  };
}

function supabaseUrl(path) {
  const base = SUPABASE_URL.replace(/\/rest\/v1\/?$/, '');
  return `${base}/rest/v1/${path}`;
}

async function supabaseInsert(table, data, prefer = 'return=representation') {
  const res = await fetch(supabaseUrl(table), {
    method: 'POST',
    headers: supabaseHeaders({ 'Prefer': prefer }),
    body: JSON.stringify(data)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase insert error (${table}): ${text}`);
  return prefer === 'return=minimal' ? null : JSON.parse(text);
}

// ─── Embedding ─────────────────────────────────────────────────────────────

async function getEmbedding(text, inputType = 'document') {
  const response = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${VOYAGE_API_KEY}` },
    body: JSON.stringify({ model: 'voyage-3', input: text, input_type: inputType })
  });
  const data = await response.json();
  if (data.error) throw new Error(`Embedding error: ${JSON.stringify(data.error)}`);
  if (!data.data?.[0]) throw new Error(`Embedding error: unexpected response`);
  return data.data[0].embedding;
}

// ─── Core ingestion ────────────────────────────────────────────────────────

async function saveRawSource(name, sourceType, rawText, handbook, sourceUrl = null) {
  const result = await supabaseInsert('raw_sources', {
    name, source_type: sourceType, source_url: sourceUrl,
    raw_text: rawText, handbook,
    metadata: { char_count: rawText.length, word_count: rawText.split(' ').length }
  });
  return result[0].id;
}

async function ingestChunks(chunks) {
  let stored = 0;
  for (const chunk of chunks) {
    let success = false;
    let attempts = 0;
    while (!success && attempts < 3) {
      try {
        attempts++;
        const embedding = await getEmbedding(chunk.content);
        await supabaseInsert('documents', { content: chunk.content, metadata: chunk.metadata, embedding }, 'return=minimal');
        stored++;
        success = true;
        await sleep(400);
      } catch (err) {
        if (attempts < 3) await sleep(attempts * 2000);
        else throw err;
      }
    }
  }
  return stored;
}

async function processAndIngest(rawText, name, handbook, sourceType, sourceUrl = null) {
  // 1. Save raw source
  const rawId = await saveRawSource(name, sourceType, rawText, handbook, sourceUrl);
  // 2. Chunk and embed
  const chunks = chunkText(rawText, name, handbook);
  const stored = await ingestChunks(chunks);
  return { rawId, chunks: stored };
}

// ─── Search ────────────────────────────────────────────────────────────────

async function searchHandbook(embedding) {
  const url = supabaseUrl('rpc/match_documents');
  const response = await fetch(url, {
    method: 'POST',
    headers: supabaseHeaders(),
    body: JSON.stringify({ query_embedding: embedding, match_threshold: 0.2, match_count: 5 })
  });
  const text = await response.text();
  try { return JSON.parse(text); } catch { throw new Error(`Search error: ${text}`); }
}

// ══════════════════════════════════════════════════════════════════════════════
// CHAT
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Invalid request' });

  try {
    const question = messages[messages.length - 1].content;
    const history = messages.slice(0, -1);
    const embedding = await getEmbedding(question, 'query');
    const chunks = await searchHandbook(embedding);

    console.log(`Q: "${question}" | Chunks: ${Array.isArray(chunks) ? chunks.length : 0} | Scores: ${Array.isArray(chunks) ? chunks.map(c => c.similarity?.toFixed(3)).join(', ') : 'none'}`);

    const context = Array.isArray(chunks) && chunks.length > 0
      ? chunks.map((c, i) => `[Section ${i + 1}${c.metadata?.source ? ' — ' + c.metadata.source : ''}]\n${c.content}`).join('\n\n')
      : 'No relevant handbook sections found.';

    const system = `You are an expert assistant for the Santa Clara County Medi-Cal Handbook (DEBS).
Answer using ONLY the handbook sections below. If the answer is not covered, say so clearly and direct to: https://stgenssa.sccgov.org/debs/program_handbooks/medi-cal/index.htm
Always mention which section your answer is from. Be clear and professional. Use bullet points for lists.

--- RELEVANT HANDBOOK SECTIONS ---
${context}
--- END ---`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 1000, system,
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

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN — INGEST
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/admin/ingest-url', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { url, name, handbook = '' } = req.body;
  try {
    const response = await fetch(url);
    const html = await response.text();
    const rawText = stripHtml(html);
    const result = await processAndIngest(rawText, name || url, handbook, 'url', url);
    res.json({ success: true, ...result, source: name || url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/ingest-text', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { text, name, handbook = '' } = req.body;
  try {
    const result = await processAndIngest(text, name || 'Manual Text', handbook, 'text');
    res.json({ success: true, ...result, source: name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/ingest-pdf', upload.single('pdf'), async (req, res) => {
  if (req.body.adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(req.file.buffer);
    const name = req.body.name || req.file.originalname;
    const handbook = req.body.handbook || '';
    const result = await processAndIngest(data.text, name, handbook, 'pdf');
    res.json({ success: true, ...result, source: name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk URL ingestion
app.post('/api/admin/ingest-bulk', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { items, handbook = '' } = req.body; // items: [{url, name}]
  if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'items array required' });

  const results = [];
  for (const item of items) {
    try {
      const response = await fetch(item.url);
      const html = await response.text();
      const rawText = stripHtml(html);
      const result = await processAndIngest(rawText, item.name || item.url, handbook, 'url', item.url);
      results.push({ success: true, name: item.name, ...result });
      await sleep(500);
    } catch (err) {
      results.push({ success: false, name: item.name, error: err.message });
    }
  }
  res.json({ results, total: items.length, succeeded: results.filter(r => r.success).length });
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN — BULK LOAD FROM OPTIMIZED JSON
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/admin/bulk-load', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { chunks, sources, clearFirst = false } = req.body;
  if (!chunks || !Array.isArray(chunks)) return res.status(400).json({ error: 'chunks array required' });

  // Respond immediately so connection doesn't timeout
  res.json({ success: true, message: 'Bulk load started', total_chunks: chunks.length, total_sources: sources?.length || 0 });

  // Process in background
  (async () => {
    try {
      console.log(`Bulk load started: ${chunks.length} chunks, clearFirst=${clearFirst}`);

      if (clearFirst) {
        await fetch(supabaseUrl('documents?id=gt.0'), { method: 'DELETE', headers: supabaseHeaders() });
        await fetch(supabaseUrl('raw_sources?id=gt.0'), { method: 'DELETE', headers: supabaseHeaders() });
        console.log('Cleared existing data');
      }

      // Save raw sources
      if (sources?.length > 0) {
        for (const src of sources) {
          try {
            await supabaseInsert('raw_sources', {
              name: src.name, source_type: src.source_type || 'pdf',
              handbook: src.handbook || 'Medi-Cal',
              raw_text: src.raw_text || '', metadata: src.metadata || {}
            }, 'return=minimal');
            await sleep(50);
          } catch (err) { console.error(`Raw source error (${src.name}): ${err.message}`); }
        }
        console.log(`Saved ${sources.length} raw sources`);
      }

      // Embed and store chunks with retry logic
      let stored = 0, errors = 0;
      for (let i = 0; i < chunks.length; i++) {
        let success = false;
        let attempts = 0;
        const maxAttempts = 3;

        while (!success && attempts < maxAttempts) {
          try {
            attempts++;
            const embedding = await getEmbedding(chunks[i].content);
            await supabaseInsert('documents', { content: chunks[i].content, metadata: chunks[i].metadata, embedding }, 'return=minimal');
            stored++;
            success = true;
            if (stored % 25 === 0) console.log(`Progress: ${stored}/${chunks.length} chunks embedded`);
            await sleep(400); // 400ms between chunks = ~2.5 RPM well under 300 RPM limit
          } catch (err) {
            console.error(`Chunk ${i} attempt ${attempts} error: ${err.message}`);
            if (attempts < maxAttempts) {
              const waitMs = attempts * 3000; // 3s, 6s between retries
              console.log(`Retrying chunk ${i} in ${waitMs/1000}s...`);
              await sleep(waitMs);
            } else {
              errors++;
              console.error(`Chunk ${i} failed after ${maxAttempts} attempts — skipping`);
            }
          }
        }
      }
      console.log(`Bulk load complete: ${stored} stored, ${errors} errors out of ${chunks.length} chunks`);
    } catch (err) { console.error('Bulk load failed:', err.message); }
  })();
});

// Check how many chunks are currently in DB
app.post('/api/admin/bulk-progress', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const countRes = await fetch(supabaseUrl('documents?select=count'), {
      headers: supabaseHeaders({ 'Prefer': 'count=exact', 'Range': '0-0' })
    });
    const countHeader = countRes.headers.get('content-range');
    const total = countHeader ? parseInt(countHeader.split('/')[1]) : 0;
    res.json({ chunks_in_db: total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN — DATA MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

// List all sources grouped
app.post('/api/admin/list', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const response = await fetch(supabaseUrl('documents?select=id,metadata&order=id.asc'), {
      headers: supabaseHeaders()
    });
    const docs = await response.json();
    const sources = {};
    docs.forEach(d => {
      const src = d.metadata?.source || 'Unknown';
      sources[src] = (sources[src] || 0) + 1;
    });
    res.json({ total: docs.length, sources });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List raw sources archive
app.post('/api/admin/raw-sources', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const response = await fetch(
      supabaseUrl('raw_sources?select=id,name,source_type,handbook,fetched_at,metadata,source_url&order=fetched_at.desc'),
      { headers: supabaseHeaders() }
    );
    const data = await response.json();
    // Fetch previews separately (first 200 chars of raw_text)
    const withPreviews = Array.isArray(data) ? data : [];
    res.json({ sources: withPreviews, total: withPreviews.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get single raw source text
app.post('/api/admin/raw-source-text', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { id } = req.body;
  try {
    const response = await fetch(supabaseUrl(`raw_sources?id=eq.${id}&select=*`), {
      headers: supabaseHeaders()
    });
    const data = await response.json();
    res.json(data[0] || null);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update raw source text and re-ingest
app.post('/api/admin/update-source', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { id, name, rawText, handbook } = req.body;
  try {
    // Get old name before updating
    const oldRes = await fetch(supabaseUrl(`raw_sources?id=eq.${id}&select=name`), {
      headers: supabaseHeaders()
    });
    const oldData = await oldRes.json();
    const oldName = oldData[0]?.name || name;

    // Update raw source
    await fetch(supabaseUrl(`raw_sources?id=eq.${id}`), {
      method: 'PATCH',
      headers: supabaseHeaders({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ name, raw_text: rawText, handbook })
    });
    // Delete old chunks using OLD name
    await fetch(supabaseUrl(`documents?metadata->>source=eq.${encodeURIComponent(oldName)}`), {
      method: 'DELETE', headers: supabaseHeaders()
    });
    // Re-ingest with new text under new name
    const chunks = chunkText(rawText, name, handbook);
    const stored = await ingestChunks(chunks);
    res.json({ success: true, chunks: stored });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete source (raw + chunks)
app.post('/api/admin/delete-source', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { source, rawId } = req.body;
  try {
    if (rawId) {
      await fetch(supabaseUrl(`raw_sources?id=eq.${rawId}`), {
        method: 'DELETE', headers: supabaseHeaders()
      });
    }
    await fetch(supabaseUrl(`documents?metadata->>source=eq.${encodeURIComponent(source)}`), {
      method: 'DELETE', headers: supabaseHeaders()
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Export all raw sources as JSON
app.post('/api/admin/export', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const response = await fetch(supabaseUrl('raw_sources?select=*&order=handbook.asc,name.asc'), {
      headers: supabaseHeaders()
    });
    const data = await response.json();
    res.json({ export: data, total: data.length, exported_at: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN — SNAPSHOTS
// ══════════════════════════════════════════════════════════════════════════════

// Save snapshot
app.post('/api/admin/snapshot-save', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { name, description } = req.body;
  try {
    // Get all current documents (without embeddings to save space)
    const docsRes = await fetch(supabaseUrl('documents?select=id,content,metadata&order=id.asc'), {
      headers: supabaseHeaders()
    });
    const docs = await docsRes.json();

    // Get all raw sources
    const rawRes = await fetch(supabaseUrl('raw_sources?select=*&order=id.asc'), {
      headers: supabaseHeaders()
    });
    const raws = await rawRes.json();

    await supabaseInsert('snapshots', {
      name, description,
      chunk_count: docs.length,
      data: { documents: docs, raw_sources: raws }
    }, 'return=minimal');

    res.json({ success: true, chunks: docs.length, sources: raws.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List snapshots
app.post('/api/admin/snapshot-list', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const response = await fetch(
      supabaseUrl('snapshots?select=id,name,description,created_at,chunk_count&order=created_at.desc'),
      { headers: supabaseHeaders() }
    );
    const data = await response.json();
    res.json({ snapshots: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Restore snapshot
app.post('/api/admin/snapshot-restore', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { id } = req.body;
  try {
    // Get snapshot data
    const snapRes = await fetch(supabaseUrl(`snapshots?id=eq.${id}&select=*`), {
      headers: supabaseHeaders()
    });
    const snaps = await snapRes.json();
    if (!snaps[0]) return res.status(404).json({ error: 'Snapshot not found' });

    const { documents, raw_sources } = snaps[0].data;

    // Clear current data immediately
    await fetch(supabaseUrl('documents?id=gt.0'), { method: 'DELETE', headers: supabaseHeaders() });
    await fetch(supabaseUrl('raw_sources?id=gt.0'), { method: 'DELETE', headers: supabaseHeaders() });

    // Restore raw sources (no embeddings needed — fast)
    if (raw_sources?.length > 0) {
      for (const src of raw_sources) {
        const { id: _, ...srcData } = src;
        await supabaseInsert('raw_sources', srcData, 'return=minimal');
        await sleep(50);
      }
    }

    // Respond immediately so Render doesn't timeout
    // Re-embedding happens in background
    res.json({ success: true, total: documents.length, sources: raw_sources?.length || 0, message: 'Restore started — re-embedding in background. Check /data in a few minutes.' });

    // Re-embed documents in background after response
    (async () => {
      for (const doc of documents) {
        try {
          const embedding = await getEmbedding(doc.content);
          await supabaseInsert('documents', { content: doc.content, metadata: doc.metadata, embedding }, 'return=minimal');
          await sleep(200);
        } catch (err) {
          console.error('Restore re-embed error:', err.message);
        }
      }
      console.log(`Snapshot restore complete: ${documents.length} chunks re-embedded`);
    })();

  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete snapshot
app.post('/api/admin/snapshot-delete', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { id } = req.body;
  try {
    await fetch(supabaseUrl(`snapshots?id=eq.${id}`), { method: 'DELETE', headers: supabaseHeaders() });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', supabase: !!SUPABASE_URL, anthropic: !!ANTHROPIC_API_KEY, voyage: !!VOYAGE_API_KEY });
});

app.get('/admin', (req, res) => res.sendFile('dashboard.html', { root: 'public' }));
app.get('/dashboard', (req, res) => res.sendFile('dashboard.html', { root: 'public' }));
app.get('/data', (req, res) => res.sendFile('dashboard.html', { root: 'public' }));
app.get('/versions', (req, res) => res.sendFile('dashboard.html', { root: 'public' }));
app.get('/loader', (req, res) => res.sendFile('dashboard.html', { root: 'public' }));
app.get('*', (req, res) => res.sendFile('index.html', { root: 'public' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
