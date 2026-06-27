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

// ─── Parallel batch embedding ──────────────────────────────────────────────
// ─── Resumable job system ──────────────────────────────────────────────────
// Jobs are tracked in Supabase so they survive Render restarts
// Job types: 'bulk-load', 'optimize', 'restore'

async function createJob(type, label, totalChunks, meta = {}) {
  const result = await supabaseInsert('embed_jobs', {
    type, label, status: 'running',
    total_chunks: totalChunks,
    stored_chunks: 0,
    error_chunks: 0,
    meta,
    started_at: new Date().toISOString()
  }, 'return=representation');
  return result[0].id;
}

async function updateJob(jobId, stored, errors, status = 'running') {
  await fetch(supabaseUrl(`embed_jobs?id=eq.${jobId}`), {
    method: 'PATCH',
    headers: supabaseHeaders({ 'Prefer': 'return=minimal' }),
    body: JSON.stringify({
      stored_chunks: stored,
      error_chunks: errors,
      status,
      updated_at: new Date().toISOString(),
      ...(status !== 'running' ? { completed_at: new Date().toISOString() } : {})
    })
  });
}

async function getJob(jobId) {
  const res = await fetch(supabaseUrl(`embed_jobs?id=eq.${jobId}&select=*`), {
    headers: supabaseHeaders()
  });
  const data = await res.json();
  return data[0] || null;
}

// Embeds chunks in parallel batches with job tracking
// If jobId provided, updates progress in Supabase so dashboard can poll it
// startFrom allows resuming from a specific chunk index
const EMBED_BATCH_SIZE = 4;
const EMBED_BATCH_DELAY = 300;

async function embedAndStoreChunks(chunks, progressLabel = '', jobId = null, startFrom = 0) {
  let stored = 0;
  let errors = 0;
  const total = chunks.length;
  const effectiveChunks = chunks.slice(startFrom);

  console.log(`${progressLabel} Starting embed: ${effectiveChunks.length} chunks (${startFrom > 0 ? `resuming from ${startFrom}` : 'fresh start'})`);

  for (let i = 0; i < effectiveChunks.length; i += EMBED_BATCH_SIZE) {
    const batch = effectiveChunks.slice(i, i + EMBED_BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (chunk) => {
        let attempts = 0;
        while (attempts < 3) {
          try {
            attempts++;
            const embedding = await getEmbedding(chunk.content);
            await supabaseInsert('documents', {
              content: chunk.content,
              metadata: chunk.metadata,
              embedding
            }, 'return=minimal');
            return true;
          } catch (err) {
            if (attempts < 3) await sleep(attempts * 2000);
            else throw err;
          }
        }
      })
    );

    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') stored++;
      else {
        errors++;
        console.error(`${progressLabel} Embed error (chunk ${startFrom + i + idx}): ${r.reason?.message}`);
      }
    });

    // Update job progress in Supabase every 4 batches (~16 chunks)
    if (jobId && (i % (EMBED_BATCH_SIZE * 4) === 0 || i + EMBED_BATCH_SIZE >= effectiveChunks.length)) {
      await updateJob(jobId, startFrom + stored, errors).catch(() => {});
    }

    if ((startFrom + stored) % 100 === 0 || i + EMBED_BATCH_SIZE >= effectiveChunks.length) {
      console.log(`${progressLabel} Progress: ${startFrom + stored}/${total} chunks${errors > 0 ? ` (${errors} errors)` : ''}`);
    }

    if (i + EMBED_BATCH_SIZE < effectiveChunks.length) await sleep(EMBED_BATCH_DELAY);
  }

  if (jobId) await updateJob(jobId, startFrom + stored, errors, errors === 0 ? 'complete' : 'complete_with_errors').catch(() => {});
  return { stored: startFrom + stored, errors };
}

async function saveRawSource(name, sourceType, rawText, handbook, sourceUrl = null, sessionId = null, sessionName = null) {
  const result = await supabaseInsert('raw_sources', {
    name, source_type: sourceType, source_url: sourceUrl,
    raw_text: rawText, handbook,
    session_id: sessionId,
    session_name: sessionName,
    metadata: { char_count: rawText.length, word_count: rawText.split(' ').length }
  });
  return result[0].id;
}

// ─── Core ingestion ────────────────────────────────────────────────────────

async function ingestChunks(chunks) {
  const { stored } = await embedAndStoreChunks(chunks, '[ingest]');
  return stored;
}

async function processAndIngest(rawText, name, handbook, sourceType, sourceUrl = null, sessionId = null, sessionName = null) {
  const rawId = await saveRawSource(name, sourceType, rawText, handbook, sourceUrl, sessionId, sessionName);
  const chunks = chunkText(rawText, name, handbook);
  const stored = await ingestChunks(chunks);
  return { rawId, chunks: stored };
}

// ─── Search ────────────────────────────────────────────────────────────────

async function searchHandbook(embedding, programFocus = '') {
  const url = supabaseUrl('rpc/match_documents');
  // Pull a slightly larger pool when a focus is set, so we can softly re-rank without losing cross-program matches
  const matchCount = programFocus ? 8 : 5;
  const response = await fetch(url, {
    method: 'POST',
    headers: supabaseHeaders(),
    body: JSON.stringify({ query_embedding: embedding, match_threshold: 0.2, match_count: matchCount })
  });
  const text = await response.text();
  let results;
  try { results = JSON.parse(text); } catch { throw new Error(`Search error: ${text}`); }

  if (!Array.isArray(results)) return results;

  if (programFocus) {
    // Soft boost: matching-handbook chunks get a small similarity bump for ranking purposes only.
    // This never excludes other handbooks — it just nudges ties toward the worker's focus area.
    const boosted = results.map(r => ({
      ...r,
      _rankScore: (r.similarity || 0) + (r.metadata?.handbook === programFocus ? 0.05 : 0)
    }));
    boosted.sort((a, b) => b._rankScore - a._rankScore);
    return boosted.slice(0, 5);
  }

  return results.slice(0, 5);
}

// ══════════════════════════════════════════════════════════════════════════════
// CHAT
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/chat', async (req, res) => {
  const { messages, programFocus = '' } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Invalid request' });

  try {
    const question = messages[messages.length - 1].content;
    const history = messages.slice(0, -1);
    const embedding = await getEmbedding(question, 'query');
    const chunks = await searchHandbook(embedding, programFocus);

    console.log(`Q: "${question}" | Focus: ${programFocus || 'none'} | Chunks: ${Array.isArray(chunks) ? chunks.length : 0} | Scores: ${Array.isArray(chunks) ? chunks.map(c => c.similarity?.toFixed(3)).join(', ') : 'none'}`);

    const context = Array.isArray(chunks) && chunks.length > 0
      ? chunks.map((c, i) => `[Section ${i + 1}${c.metadata?.source ? ' — ' + c.metadata.source : ''}]\n${c.content}`).join('\n\n')
      : 'No relevant handbook sections found.';

    const focusNote = programFocus
      ? `\nThe worker has indicated their primary focus area is ${programFocus}. Prioritize that lens when relevant, but still surface other program handbook content (e.g. Medi-Cal, CalWORKs) when the question involves a shared household, joint eligibility, or cross-program procedure.\n`
      : '';

    const system = `You are the DEBS Program Assistant for Santa Clara County, supporting eligibility workers across Medi-Cal, CalFresh, CalWORKs, General Relief, Foster Care, MEDS, and related Job Aids.
Answer using ONLY the handbook sections below. If the answer is not covered, say so clearly and recommend the worker consult their program handbook directly or escalate to a supervisor.
Always mention which section your answer is from. Be clear and professional. Use bullet points for lists.${focusNote}
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

    const reply = data.content[0].text;
    const chunkData = Array.isArray(chunks) ? chunks.map(c => ({
      source: c.metadata?.source || 'Unknown',
      handbook: c.metadata?.handbook || 'Unknown',
      similarity: c.similarity || 0,
      preview: c.content?.substring(0, 100)
    })) : [];

    res.json({
      reply,
      chunksFound: chunkData.length,
      avgSimilarity: chunkData.length > 0 ? chunkData.reduce((a,b) => a + b.similarity, 0) / chunkData.length : 0,
      chunkData
    });
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
  const { url, name, handbook = '', archiveOnly = false, sessionId = null, sessionName = null } = req.body;
  try {
    const response = await fetch(url);
    const html = await response.text();
    const rawText = stripHtml(html);
    if (archiveOnly) {
      const rawId = await saveRawSource(name || url, 'url', rawText, handbook, url, sessionId, sessionName);
      res.json({ success: true, rawId, chunks: 0, archived: true, source: name || url });
    } else {
      const result = await processAndIngest(rawText, name || url, handbook, 'url', url, sessionId, sessionName);
      res.json({ success: true, ...result, source: name || url });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/ingest-text', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { text, name, handbook = '', archiveOnly = false, sessionId = null, sessionName = null } = req.body;
  try {
    if (archiveOnly) {
      const rawId = await saveRawSource(name || 'Manual Text', 'text', text, handbook, null, sessionId, sessionName);
      res.json({ success: true, rawId, chunks: 0, archived: true, source: name });
    } else {
      const result = await processAndIngest(text, name || 'Manual Text', handbook, 'text', null, sessionId, sessionName);
      res.json({ success: true, ...result, source: name });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/ingest-pdf', upload.single('pdf'), async (req, res) => {
  if (req.body.adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(req.file.buffer);
    const name = req.body.name || req.file.originalname.replace('.pdf', '');
    const handbook = req.body.handbook || '';
    const archiveOnly = req.body.archiveOnly === 'true';
    const sessionId = req.body.sessionId || null;
    const sessionName = req.body.sessionName || null;
    if (archiveOnly) {
      const rawId = await saveRawSource(name, 'pdf', data.text, handbook, null, sessionId, sessionName);
      res.json({ success: true, rawId, chunks: 0, archived: true, source: name });
    } else {
      const result = await processAndIngest(data.text, name, handbook, 'pdf', null, sessionId, sessionName);
      res.json({ success: true, ...result, source: name });
    }
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
  const { chunks, sources, clearFirst = false, chunksOnly = false } = req.body;
  if (!chunks || !Array.isArray(chunks)) return res.status(400).json({ error: 'chunks array required' });

  // Create a job record immediately for tracking and resumability
  let jobId = null;
  try {
    jobId = await createJob('bulk-load', `Bulk load — ${chunks.length} chunks`, chunks.length, { chunks, clearFirst, chunksOnly });
  } catch (err) { console.error('Job create failed:', err.message); }

  // Respond immediately
  res.json({ success: true, message: 'Bulk load started', total_chunks: chunks.length, total_sources: sources?.length || 0, chunksOnly, jobId });

  // Process in background
  (async () => {
    try {
      console.log(`Bulk load started: ${chunks.length} chunks, clearFirst=${clearFirst}, chunksOnly=${chunksOnly}, jobId=${jobId}`);

      if (clearFirst) {
        await fetch(supabaseUrl('documents?id=gt.0'), { method: 'DELETE', headers: supabaseHeaders() });
        if (!chunksOnly) await fetch(supabaseUrl('raw_sources?id=gt.0'), { method: 'DELETE', headers: supabaseHeaders() });
        console.log('Cleared existing data');
      }

      // Save raw sources only if NOT in chunksOnly mode
      if (!chunksOnly && sources?.length > 0) {
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
      } else if (chunksOnly) {
        console.log('Chunks only mode — skipping raw sources save');
      }

      // Embed and store chunks with job tracking
      const { stored, errors } = await embedAndStoreChunks(chunks, '[bulk-load]', jobId);
      console.log(`Bulk load complete: ${stored} stored, ${errors} errors out of ${chunks.length} chunks`);
    } catch (err) {
      console.error('Bulk load failed:', err.message);
      if (jobId) await updateJob(jobId, 0, 0, 'failed').catch(() => {});
    }
  })();
});

// Check job progress (used by bulk loader polling)
app.post('/api/admin/bulk-progress', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const { jobId } = req.body;
    // If jobId provided use job tracking, otherwise fall back to counting docs
    if (jobId) {
      const job = await getJob(jobId);
      if (job) return res.json({ chunks_in_db: job.stored_chunks, status: job.status, total: job.total_chunks, jobId });
    }
    // Fallback: count all documents
    const countRes = await fetch(supabaseUrl('documents?select=count'), {
      headers: supabaseHeaders({ 'Prefer': 'count=exact', 'Range': '0-0' })
    });
    const countHeader = countRes.headers.get('content-range');
    const total = countHeader ? parseInt(countHeader.split('/')[1]) : 0;
    res.json({ chunks_in_db: total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Check job progress
app.post('/api/admin/job-progress', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { jobId } = req.body;
  try {
    if (jobId) {
      const job = await getJob(jobId);
      return res.json({ job });
    }
    // Return all recent jobs
    const response = await fetch(
      supabaseUrl('embed_jobs?select=*&order=started_at.desc&limit=10'),
      { headers: supabaseHeaders() }
    );
    const jobs = await response.json();
    res.json({ jobs: Array.isArray(jobs) ? jobs : [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Resume a failed/interrupted bulk load job
app.post('/api/admin/resume-job', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { jobId } = req.body;
  try {
    const job = await getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status === 'complete') return res.json({ success: true, message: 'Job already complete' });

    const chunks = job.meta?.chunks;
    if (!chunks || !Array.isArray(chunks)) return res.status(400).json({ error: 'Job has no chunk data to resume' });

    const startFrom = job.stored_chunks || 0;
    res.json({ success: true, message: `Resuming from chunk ${startFrom}`, totalChunks: chunks.length, startFrom });

    await updateJob(jobId, startFrom, job.error_chunks || 0, 'running');

    (async () => {
      try {
        const { stored, errors } = await embedAndStoreChunks(chunks, `[resume-${jobId}]`, jobId, startFrom);
        console.log(`Resume complete: ${stored}/${chunks.length} chunks stored, ${errors} errors`);
      } catch (err) {
        console.error(`Resume failed: ${err.message}`);
        await updateJob(jobId, job.stored_chunks, job.error_chunks, 'failed');
      }
    })();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN — DATA MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

// List all sources grouped
app.post('/api/admin/list', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    // Get total count first
    const countRes = await fetch(supabaseUrl('documents?select=count'), {
      headers: supabaseHeaders({ 'Prefer': 'count=exact', 'Range': '0-0' })
    });
    const countHeader = countRes.headers.get('content-range');
    const total = countHeader ? parseInt(countHeader.split('/')[1]) : 0;

    // Fetch all docs in batches of 1000
    let allDocs = [];
    let offset = 0;
    const batchSize = 1000;
    while (offset < total) {
      const batchRes = await fetch(
        supabaseUrl(`documents?select=id,metadata&order=id.asc&limit=${batchSize}&offset=${offset}`),
        { headers: supabaseHeaders({ 'Range': `${offset}-${offset + batchSize - 1}` }) }
      );
      const batch = await batchRes.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      allDocs = allDocs.concat(batch);
      offset += batchSize;
    }

    // Group by handbook then source
    const byHandbook = {};
    const sources = {};
    allDocs.forEach(d => {
      const src = d.metadata?.source || 'Unknown';
      const hb = d.metadata?.handbook || 'Unknown';
      sources[src] = (sources[src] || 0) + 1;
      byHandbook[hb] = (byHandbook[hb] || 0) + 1;
    });

    res.json({ total: allDocs.length, sources, byHandbook });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lightweight archive summary — grouped by handbook (no raw_text fetched)
app.post('/api/admin/archive-summary', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    // Fetch just handbook + metadata without raw_text for speed
    const countRes = await fetch(supabaseUrl('raw_sources?select=count'), {
      headers: supabaseHeaders({ 'Prefer': 'count=exact', 'Range': '0-0' })
    });
    const total = parseInt(countRes.headers.get('content-range')?.split('/')[1] || '0');

    // Fetch in batches — only lightweight fields, no raw_text
    let allSources = [];
    let offset = 0;
    while (offset < total) {
      const batchRes = await fetch(
        supabaseUrl(`raw_sources?select=handbook,metadata&order=handbook.asc&limit=1000&offset=${offset}`),
        { headers: supabaseHeaders({ 'Range': `${offset}-${offset + 999}` }) }
      );
      const batch = await batchRes.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      allSources = allSources.concat(batch);
      offset += 1000;
    }

    // Group by handbook
    const grouped = {};
    allSources.forEach(s => {
      const hb = s.handbook || 'Unknown';
      if (!grouped[hb]) grouped[hb] = { handbook: hb, sources: 0, total_chars: 0 };
      grouped[hb].sources++;
      grouped[hb].total_chars += s.metadata?.char_count || 0;
    });

    const summary = Object.values(grouped).sort((a, b) => a.handbook.localeCompare(b.handbook));
    res.json({ summary, total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List raw sources archive
app.post('/api/admin/raw-sources', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    // Get total count
    const countRes = await fetch(supabaseUrl('raw_sources?select=count'), {
      headers: supabaseHeaders({ 'Prefer': 'count=exact', 'Range': '0-0' })
    });
    const countHeader = countRes.headers.get('content-range');
    const total = countHeader ? parseInt(countHeader.split('/')[1]) : 0;

    // Fetch all in batches
    let allSources = [];
    let offset = 0;
    const batchSize = 1000;
    while (offset < total) {
      const batchRes = await fetch(
        supabaseUrl(`raw_sources?select=id,name,source_type,handbook,fetched_at,metadata,source_url&order=fetched_at.desc&limit=${batchSize}&offset=${offset}`),
        { headers: supabaseHeaders({ 'Range': `${offset}-${offset + batchSize - 1}` }) }
      );
      const batch = await batchRes.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      allSources = allSources.concat(batch);
      offset += batchSize;
    }

    res.json({ sources: allSources, total: allSources.length });
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
    // Get total count first
    const countRes = await fetch(supabaseUrl('raw_sources?select=count'), {
      headers: supabaseHeaders({ 'Prefer': 'count=exact', 'Range': '0-0' })
    });
    const total = parseInt(countRes.headers.get('content-range')?.split('/')[1] || '0');

    // Fetch all in batches of 500
    let allSources = [];
    let offset = 0;
    const batchSize = 500;
    while (offset < total) {
      const batchRes = await fetch(
        supabaseUrl(`raw_sources?select=*&order=handbook.asc,name.asc&limit=${batchSize}&offset=${offset}`),
        { headers: supabaseHeaders({ 'Range': `${offset}-${offset + batchSize - 1}` }) }
      );
      const batch = await batchRes.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      allSources = allSources.concat(batch);
      offset += batchSize;
      console.log(`Export: fetched ${allSources.length}/${total} sources`);
    }

    res.json({ export: allSources, total: allSources.length, exported_at: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Export by session ID only
app.post('/api/admin/export-session', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  try {
    const response = await fetch(
      supabaseUrl(`raw_sources?session_id=eq.${encodeURIComponent(sessionId)}&select=*&order=name.asc`),
      { headers: supabaseHeaders() }
    );
    const data = await response.json();
    res.json({ export: data, total: data.length, sessionId, exported_at: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Source quality scanner ─────────────────────────────────────────────────

function scoreSourceQuality(raw_text, name) {
  if (!raw_text || raw_text.trim().length === 0) {
    return { score: 0, flags: ['empty'], wordCount: 0, lineCount: 0, avgLineLen: 0, numericDensity: 0 };
  }

  const lines = raw_text.split('\n').filter(l => l.trim().length > 0);
  const words = raw_text.split(/\s+/).filter(w => w.length > 0);
  const chars = raw_text.replace(/\s/g, '').length;

  const lineCount = lines.length;
  const wordCount = words.length;
  const avgLineLen = lineCount > 0 ? chars / lineCount : 0;
  const wordsPerLine = lineCount > 0 ? wordCount / lineCount : 0;

  // Numeric density — what fraction of words are numbers or codes
  const numericWords = words.filter(w => /^\d+[\d\-\.]*$/.test(w) || /^[\d]{3,}$/.test(w)).length;
  const numericDensity = wordCount > 0 ? numericWords / wordCount : 0;

  // Short line ratio — what fraction of lines are very short (under 5 words)
  const shortLines = lines.filter(l => l.trim().split(/\s+/).length < 5).length;
  const shortLineRatio = lineCount > 0 ? shortLines / lineCount : 0;

  // Repetitive header ratio — lines that look like PDF headers/footers
  const headerPattern = /^(page \d+|mcp code dir|\d+\s*$|part \d+|updated:|page updated)/i;
  const headerLines = lines.filter(l => headerPattern.test(l.trim())).length;
  const headerRatio = lineCount > 0 ? headerLines / lineCount : 0;

  // Flag conditions
  const flags = [];
  if (wordCount < 50) flags.push('too_short');
  if (wordsPerLine < 4) flags.push('low_words_per_line');
  if (numericDensity > 0.20) flags.push('high_numeric_density');
  if (shortLineRatio > 0.50) flags.push('high_short_line_ratio');
  if (headerRatio > 0.10) flags.push('high_header_noise');
  if (avgLineLen < 15) flags.push('short_avg_line');

  // Quality score 0-100 (higher = better quality)
  let score = 100;
  if (flags.includes('too_short')) score -= 40;
  if (flags.includes('low_words_per_line')) score -= 25;
  if (flags.includes('high_numeric_density')) score -= 20;
  if (flags.includes('high_short_line_ratio')) score -= 20;
  if (flags.includes('high_header_noise')) score -= 15;
  if (flags.includes('short_avg_line')) score -= 15;
  score = Math.max(0, score);

  return { score, flags, wordCount, lineCount, avgLineLen: Math.round(avgLineLen), wordsPerLine: Math.round(wordsPerLine * 10) / 10, numericDensity: Math.round(numericDensity * 100), shortLineRatio: Math.round(shortLineRatio * 100) };
}

app.post('/api/admin/scan-quality', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { handbook, limit = 50 } = req.body;

  try {
    // Get total count
    const countUrl = handbook
      ? `raw_sources?handbook=eq.${encodeURIComponent(handbook)}&select=count`
      : 'raw_sources?select=count';
    const countRes = await fetch(supabaseUrl(countUrl), {
      headers: supabaseHeaders({ 'Prefer': 'count=exact', 'Range': '0-0' })
    });
    const total = parseInt(countRes.headers.get('content-range')?.split('/')[1] || '0');

    // Fetch all sources in batches — only fields needed for scoring
    let allSources = [];
    let offset = 0;
    const batchSize = 200;
    const baseUrl = handbook
      ? `raw_sources?handbook=eq.${encodeURIComponent(handbook)}&select=id,name,handbook,raw_text&order=name.asc`
      : 'raw_sources?select=id,name,handbook,raw_text&order=handbook.asc,name.asc';

    while (offset < total) {
      const batchRes = await fetch(
        supabaseUrl(`${baseUrl}&limit=${batchSize}&offset=${offset}`),
        { headers: supabaseHeaders({ 'Range': `${offset}-${offset + batchSize - 1}` }) }
      );
      const batch = await batchRes.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      allSources = allSources.concat(batch);
      offset += batchSize;
    }

    // Score each source
    const scored = allSources.map(src => {
      const quality = scoreSourceQuality(src.raw_text, src.name);
      return {
        id: src.id,
        name: src.name,
        handbook: src.handbook,
        ...quality
      };
    });

    // Sort by score ascending (worst first)
    scored.sort((a, b) => a.score - b.score);

    // Summary stats
    const flagged = scored.filter(s => s.flags.length > 0);
    const byHandbook = {};
    scored.forEach(s => {
      if (!byHandbook[s.handbook]) byHandbook[s.handbook] = { total: 0, flagged: 0, avgScore: 0, scores: [] };
      byHandbook[s.handbook].total++;
      byHandbook[s.handbook].scores.push(s.score);
      if (s.flags.length > 0) byHandbook[s.handbook].flagged++;
    });
    Object.values(byHandbook).forEach(hb => {
      hb.avgScore = Math.round(hb.scores.reduce((a, b) => a + b, 0) / hb.scores.length);
      delete hb.scores;
    });

    res.json({
      total: allSources.length,
      flagged: flagged.length,
      flaggedPct: Math.round(flagged.length / allSources.length * 100),
      byHandbook,
      worstSources: scored.slice(0, limit), // worst quality first
      scannedAt: new Date().toISOString()
    });

  } catch (err) { res.status(500).json({ error: err.message }); }
});

// AI reformat a single source using Sonnet
app.post('/api/admin/reformat-source', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });

  try {
    // Fetch the source
    const srcRes = await fetch(supabaseUrl(`raw_sources?id=eq.${id}&select=*`), {
      headers: supabaseHeaders()
    });
    const sources = await srcRes.json();
    if (!Array.isArray(sources) || !sources[0]) return res.status(404).json({ error: 'Source not found' });
    const source = sources[0];

    // Respond immediately — reformat runs in background
    res.json({ success: true, message: `Reformatting "${source.name}" in background...`, id });

    (async () => {
      try {
        console.log(`🔄 Reformatting source: "${source.name}" (${source.handbook})`);

        const prompt = `You are reformatting a Medi-Cal policy document that was extracted from a PDF. The extraction may have produced garbled text, broken table rows, or fragmented sentences.

Reformat the following raw text into clean, natural language sentences that will be easy to search semantically. Follow these rules:
1. Convert any tables or code lists into clear sentences like "HCP number 309 is Santa Clara Family Health Plan, a Two-Plan Local Initiative. Phone: (408) 376-2000."
2. Remove PDF artifacts like page numbers, repeated headers, navigation text, and divider lines
3. Preserve all factual content — do not add or invent information
4. Convert bullet points and numbered lists into complete sentences
5. Keep all policy details, dates, dollar amounts, code numbers, and proper names exactly as they appear
6. Output only the reformatted text — no preamble, no explanation

Source name: ${source.name}
Handbook: ${source.handbook}

Raw text to reformat:
${source.raw_text.substring(0, 6000)}`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 4000,
            messages: [{ role: 'user', content: prompt }]
          })
        });

        const data = await response.json();
        if (data.error || !data.content?.[0]) {
          console.error(`Reformat API error for "${source.name}": ${JSON.stringify(data.error)}`);
          return;
        }

        const reformatted = data.content[0].text.trim();
        console.log(`✅ Reformatted "${source.name}": ${source.raw_text.length} → ${reformatted.length} chars`);

        // Save reformatted text back to raw_sources
        await fetch(supabaseUrl(`raw_sources?id=eq.${id}`), {
          method: 'PATCH',
          headers: supabaseHeaders({ 'Prefer': 'return=minimal' }),
          body: JSON.stringify({ raw_text: reformatted })
        });

        console.log(`💾 Saved reformatted text for "${source.name}"`);
      } catch (err) {
        console.error(`Reformat failed for id ${id}: ${err.message}`);
      }
    })();

  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List all sessions
app.post('/api/admin/sessions', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    // Get count first
    const countRes = await fetch(supabaseUrl('raw_sources?select=count'), {
      headers: supabaseHeaders({ 'Prefer': 'count=exact', 'Range': '0-0' })
    });
    const total = parseInt(countRes.headers.get('content-range')?.split('/')[1] || '0');

    // Fetch lightweight fields only in batches
    let allRows = [];
    let offset = 0;
    while (offset < total) {
      const batchRes = await fetch(
        supabaseUrl(`raw_sources?select=session_id,session_name,handbook,fetched_at&order=fetched_at.desc&limit=500&offset=${offset}`),
        { headers: supabaseHeaders({ 'Range': `${offset}-${offset + 499}` }) }
      );
      const batch = await batchRes.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      allRows = allRows.concat(batch);
      offset += 500;
    }

    const sessions = {};
    allRows.forEach(item => {
      const sid = item.session_id || 'no-session';
      const sname = item.session_name || 'No Session';
      if (!sessions[sid]) sessions[sid] = { sessionId: sid, sessionName: sname, handbook: item.handbook, count: 0, createdAt: item.fetched_at };
      sessions[sid].count++;
    });
    res.json({ sessions: Object.values(sessions).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)) });
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
    // Get total document count
    const countRes = await fetch(supabaseUrl('documents?select=count'), {
      headers: supabaseHeaders({ 'Prefer': 'count=exact', 'Range': '0-0' })
    });
    const countHeader = countRes.headers.get('content-range');
    const total = countHeader ? parseInt(countHeader.split('/')[1]) : 0;

    // Respond immediately so connection doesn't timeout
    res.json({ success: true, chunks: total, message: 'Snapshot saving in background...' });

    // Save in background
    (async () => {
      try {
        const batchSize = 500;
        let allDocs = [];
        let offset = 0;

        // Fetch all docs in batches
        while (offset < total) {
          const batchRes = await fetch(
            supabaseUrl(`documents?select=id,content,metadata&order=id.asc&limit=${batchSize}&offset=${offset}`),
            { headers: supabaseHeaders({ 'Range': `${offset}-${offset + batchSize - 1}` }) }
          );
          const batch = await batchRes.json();
          if (!Array.isArray(batch) || batch.length === 0) break;
          allDocs = allDocs.concat(batch);
          offset += batchSize;
          console.log(`Snapshot fetch: ${allDocs.length}/${total} docs`);
        }

        // Save snapshot in chunks of 500 docs per row to avoid blob size limit
        // First row stores metadata + first batch, additional rows store overflow
        const chunkBatchSize = 500;
        const batches = [];
        for (let i = 0; i < allDocs.length; i += chunkBatchSize) {
          batches.push(allDocs.slice(i, i + chunkBatchSize));
        }

        // Save first row with metadata
        const firstRow = await supabaseInsert('snapshots', {
          name,
          description: description || null,
          chunk_count: allDocs.length,
          data: { documents: batches[0] || [], batch: 0, total_batches: batches.length }
        }, 'return=representation');

        const snapshotId = firstRow?.[0]?.id;
        console.log(`Snapshot row 1/${batches.length} saved (id: ${snapshotId})`);

        // Save remaining batches as continuation rows
        for (let b = 1; b < batches.length; b++) {
          await supabaseInsert('snapshots', {
            name: `${name} [part ${b + 1}]`,
            description: `Continuation of snapshot: ${snapshotId}`,
            chunk_count: 0,
            data: { documents: batches[b], batch: b, total_batches: batches.length, parent_id: snapshotId }
          }, 'return=minimal');
          console.log(`Snapshot row ${b + 1}/${batches.length} saved`);
          await sleep(200);
        }

        console.log(`✅ Snapshot "${name}" complete: ${allDocs.length} chunks across ${batches.length} rows`);
      } catch (err) {
        console.error(`Snapshot background save failed: ${err.message}`);
      }
    })();

  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List snapshots — only show parent rows (not continuation parts)
app.post('/api/admin/snapshot-list', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const response = await fetch(
      supabaseUrl('snapshots?select=id,name,description,created_at,chunk_count&order=created_at.desc'),
      { headers: supabaseHeaders() }
    );
    const data = await response.json();
    // Filter out continuation rows (they have chunk_count=0 and name contains "[part")
    const parents = Array.isArray(data) ? data.filter(s => !s.name.includes('[part ')) : [];
    res.json({ snapshots: parents });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Restore snapshot — handles multi-row snapshots with parallel batch embedding
app.post('/api/admin/snapshot-restore', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { id } = req.body;
  try {
    // Get the parent snapshot row
    const snapRes = await fetch(supabaseUrl(`snapshots?id=eq.${id}&select=*`), {
      headers: supabaseHeaders()
    });
    const snaps = await snapRes.json();
    if (!snaps[0]) return res.status(404).json({ error: 'Snapshot not found' });
    const snap = snaps[0];

    // Collect all documents from parent + continuation rows
    let allDocuments = snap.data?.documents || [];
    const totalBatches = snap.data?.total_batches || 1;

    if (totalBatches > 1) {
      const partsRes = await fetch(supabaseUrl(`snapshots?select=*&order=created_at.asc`), {
        headers: supabaseHeaders()
      });
      const allRows = await partsRes.json();
      const parts = Array.isArray(allRows)
        ? allRows.filter(r => r.data?.parent_id === id && r.data?.batch > 0)
            .sort((a, b) => a.data.batch - b.data.batch)
        : [];
      for (const part of parts) {
        allDocuments = allDocuments.concat(part.data?.documents || []);
      }
      console.log(`Restore: assembled ${allDocuments.length} docs from ${parts.length + 1} rows`);
    }

    if (allDocuments.length === 0) return res.status(400).json({ error: 'Snapshot contains no documents' });

    // Clear current documents
    await fetch(supabaseUrl('documents?id=gt.0'), { method: 'DELETE', headers: supabaseHeaders() });
    console.log(`Restore: cleared existing documents, starting re-embed of ${allDocuments.length} chunks`);

    // Respond immediately
    res.json({ success: true, total: allDocuments.length, message: `Restore started — ${allDocuments.length} chunks re-embedding in background using parallel batches.` });

    // Re-embed in background using parallel batch embedding
    (async () => {
      let restored = 0;
      let errors = 0;
      const BATCH = 4;
      const DELAY = 300;

      for (let i = 0; i < allDocuments.length; i += BATCH) {
        const batch = allDocuments.slice(i, i + BATCH);
        const results = await Promise.allSettled(
          batch.map(async (doc) => {
            let attempts = 0;
            while (attempts < 3) {
              try {
                attempts++;
                const embedding = await getEmbedding(doc.content);
                await supabaseInsert('documents', { content: doc.content, metadata: doc.metadata, embedding }, 'return=minimal');
                return true;
              } catch (err) {
                if (attempts < 3) await sleep(attempts * 2000);
                else throw err;
              }
            }
          })
        );
        results.forEach(r => r.status === 'fulfilled' ? restored++ : errors++);
        if (restored % 100 === 0 || i + BATCH >= allDocuments.length) {
          console.log(`Restore progress: ${restored}/${allDocuments.length} chunks`);
        }
        if (i + BATCH < allDocuments.length) await sleep(DELAY);
      }
      console.log(`✅ Restore complete: ${restored} chunks re-embedded, ${errors} errors`);
    })();

  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete snapshot
app.post('/api/admin/snapshot-delete', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { id } = req.body;
  try {
    // Delete the parent row
    await fetch(supabaseUrl(`snapshots?id=eq.${id}`), { method: 'DELETE', headers: supabaseHeaders() });
    // Delete any continuation rows that reference this parent
    // They store parent_id inside the data jsonb field — filter by name pattern as a safety net
    const allRes = await fetch(supabaseUrl('snapshots?select=id,name,data'), { headers: supabaseHeaders() });
    const all = await allRes.json();
    if (Array.isArray(all)) {
      const parts = all.filter(r => r.data?.parent_id === id);
      for (const part of parts) {
        await fetch(supabaseUrl(`snapshots?id=eq.${part.id}`), { method: 'DELETE', headers: supabaseHeaders() });
      }
      if (parts.length > 0) console.log(`Deleted ${parts.length} continuation rows for snapshot ${id}`);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// RATINGS & AUTO-OPTIMIZATION
// ══════════════════════════════════════════════════════════════════════════════

// Save a rating
app.post('/api/rate', async (req, res) => {
  const { question, answer, rating, comment, chunkData, chunksFound, avgSimilarity } = req.body;
  if (!question || !answer || !rating) return res.status(400).json({ error: 'question, answer, rating required' });
  try {
    const inserted = await supabaseInsert('ratings', {
      question, answer, rating,
      comment: comment || null,
      chunks_used: chunkData || [],
      chunks_found: chunksFound || 0,
      avg_similarity: avgSimilarity || 0,
      optimized: false
    }, 'return=representation');

    const ratingId = Array.isArray(inserted) && inserted[0] ? inserted[0].id : null;
    res.json({ success: true });

    // If thumbs down — generate optimization suggestion in background (goes to PENDING)
    if (rating === -1) {
      setImmediate(() => {
        optimizeChunksForQuestion(question, answer, chunkData || [], ratingId)
          .catch(err => console.error('Post-rating optimization error:', err.message));
      });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Background optimization — saves to PENDING, not directly to knowledge base
async function optimizeChunksForQuestion(question, answer, chunkData, ratingId) {
  try {
    console.log(`Generating optimization suggestion for: "${question}"`);

    if (!chunkData || chunkData.length === 0) {
      console.log('No chunks to optimize');
      return;
    }

    const sources = [...new Set(chunkData.map(c => c.source))].join(', ');
    const handbook = chunkData[0]?.handbook || 'Unknown';

    const analysisPrompt = `A user asked this question and gave the answer a thumbs down (bad rating):

QUESTION: ${question}

ANSWER GIVEN: ${answer}

SOURCES USED: ${sources}

Analyze why the answer may have been unsatisfactory. Then write improved content that would better answer this question. The improved text should:
1. Directly address the question in the first sentence
2. Include all relevant policy details, steps, or rules
3. Be written as clear policy guidance (not conversational)
4. Be 200-400 words

Respond in JSON format only — no preamble, no markdown backticks:
{
  "issue": "brief description of what was wrong or missing",
  "improved_content": "the improved chunk text here",
  "suggested_source_name": "a clear descriptive name for this content"
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{ role: 'user', content: analysisPrompt }]
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const text = data.content[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    // Save as PENDING — not added to knowledge base yet
    await supabaseInsert('pending_optimizations', {
      rating_id: ratingId || null,
      question,
      original_answer: answer,
      issue_identified: result.issue,
      suggested_content: result.improved_content,
      suggested_source_name: result.suggested_source_name,
      handbook,
      status: 'pending'
    }, 'return=minimal');

    console.log(`✅ Optimization suggestion saved as PENDING for: "${question}"`);
  } catch (err) {
    console.error(`Optimization suggestion failed for "${question}": ${err.message}`);
  }
}

// Get all ratings (admin)
app.post('/api/admin/ratings', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const response = await fetch(
      supabaseUrl('ratings?select=*&order=created_at.desc&limit=200'),
      { headers: supabaseHeaders() }
    );
    const data = await response.json();
    const total = data.length;
    const positive = data.filter(r => r.rating === 1).length;
    const negative = data.filter(r => r.rating === -1).length;
    const optimized = data.filter(r => r.optimized).length;
    const avgSim = data.length > 0
      ? (data.reduce((a, b) => a + (b.avg_similarity || 0), 0) / data.length).toFixed(3)
      : 0;
    res.json({ ratings: data, stats: { total, positive, negative, optimized, avgSimilarity: avgSim } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get pending optimizations
app.post('/api/admin/pending-optimizations', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const response = await fetch(
      supabaseUrl('pending_optimizations?select=*&order=created_at.desc'),
      { headers: supabaseHeaders() }
    );
    const data = await response.json();
    const pending = Array.isArray(data) ? data.filter(d => d.status === 'pending') : [];
    const approved = Array.isArray(data) ? data.filter(d => d.status === 'approved') : [];
    const rejected = Array.isArray(data) ? data.filter(d => d.status === 'rejected') : [];
    res.json({ optimizations: data, stats: { pending: pending.length, approved: approved.length, rejected: rejected.length, total: data.length } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Approve optimization — adds to knowledge base
app.post('/api/admin/approve-optimization', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { id, content, sourceName } = req.body;
  try {
    // Get the optimization
    const optRes = await fetch(supabaseUrl(`pending_optimizations?id=eq.${id}&select=*`), {
      headers: supabaseHeaders()
    });
    const opts = await optRes.json();
    if (!opts[0]) return res.status(404).json({ error: 'Optimization not found' });
    const opt = opts[0];

    // Use edited content if provided, otherwise use original suggestion
    const finalContent = content || opt.suggested_content;
    const finalName = sourceName || opt.suggested_source_name;

    // Embed and add to knowledge base
    const embedding = await getEmbedding(finalContent);
    await supabaseInsert('documents', {
      content: finalContent,
      metadata: {
        source: finalName,
        handbook: opt.handbook || 'Optimized',
        category: 'Admin-Approved',
        optimized: true,
        original_question: opt.question,
        optimization_date: new Date().toISOString()
      },
      embedding
    }, 'return=minimal');

    // Save to raw_sources
    await supabaseInsert('raw_sources', {
      name: finalName,
      source_type: 'text',
      handbook: opt.handbook || 'Optimized',
      raw_text: finalContent,
      metadata: {
        admin_approved: true,
        original_question: opt.question,
        issue: opt.issue_identified,
        word_count: finalContent.split(' ').length
      }
    }, 'return=minimal');

    // Update status to approved
    await fetch(supabaseUrl(`pending_optimizations?id=eq.${id}`), {
      method: 'PATCH',
      headers: supabaseHeaders({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ status: 'approved', reviewed_at: new Date().toISOString() })
    });

    // Mark rating as optimized
    if (opt.rating_id) {
      await fetch(supabaseUrl(`ratings?id=eq.${opt.rating_id}`), {
        method: 'PATCH',
        headers: supabaseHeaders({ 'Prefer': 'return=minimal' }),
        body: JSON.stringify({ optimized: true, optimization_notes: opt.issue_identified })
      });
    }

    res.json({ success: true, source: finalName });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reject optimization
app.post('/api/admin/reject-optimization', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { id, notes } = req.body;
  try {
    await fetch(supabaseUrl(`pending_optimizations?id=eq.${id}`), {
      method: 'PATCH',
      headers: supabaseHeaders({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ status: 'rejected', reviewed_at: new Date().toISOString(), reviewer_notes: notes || null })
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Manually trigger optimization for a specific rating
app.post('/api/admin/optimize-rating', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { ratingId } = req.body;
  try {
    const ratingRes = await fetch(supabaseUrl(`ratings?id=eq.${ratingId}&select=*`), {
      headers: supabaseHeaders()
    });
    const ratings = await ratingRes.json();
    if (!ratings[0]) return res.status(404).json({ error: 'Rating not found' });
    const r = ratings[0];
    res.json({ success: true, message: 'Optimization suggestion being generated' });
    optimizeChunksForQuestion(r.question, r.answer, r.chunks_used || [], r.id);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get optimization stats
app.post('/api/admin/optimization-stats', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const response = await fetch(
      supabaseUrl("documents?select=id,metadata&metadata->>category=eq.Admin-Approved"),
      { headers: supabaseHeaders() }
    );
    const data = await response.json();
    res.json({ auto_optimized_chunks: Array.isArray(data) ? data.length : 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete a rating
app.post('/api/admin/delete-rating', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { id } = req.body;
  try {
    await fetch(supabaseUrl(`ratings?id=eq.${id}`), { method: 'DELETE', headers: supabaseHeaders() });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', supabase: !!SUPABASE_URL, anthropic: !!ANTHROPIC_API_KEY, voyage: !!VOYAGE_API_KEY });
});

// ══════════════════════════════════════════════════════════════════════════════
// OPTIMIZATION ENGINE
// ══════════════════════════════════════════════════════════════════════════════

// ─── Optimization helpers ──────────────────────────────────────────────────

function removePdfNoise(text) {
  return text
    // Page numbers
    .replace(/Page \d+ of \d+/gi, '')
    .replace(/^\d+\s*$/gm, '')
    // County/DEBS headers
    .replace(/^.{0,60}(County|DEBS|Confidential|Internal Use|Santa Clara).{0,60}$/gm, '')
    // Navigation text
    .replace(/^(Previous|Next|Home|Back|Top|Table of Contents|Skip to|Jump to|Print|Share|Email|Download)\s*.*$/gmi, '')
    // URL-like text
    .replace(/https?:\/\/\S+/g, '')
    // Repeated punctuation dividers
    .replace(/_{3,}/g, '')
    .replace(/─{3,}/g, '')
    .replace(/={3,}/g, '')
    .replace(/\*{3,}/g, '')
    .replace(/-{5,}/g, '')
    // Whitespace cleanup
    .replace(/\t+/g, ' ')
    .replace(/ {3,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function removeShortLines(text, minWords = 5) {
  return text.split('\n').filter(line => {
    const words = line.trim().split(/\s+/).filter(w => w.length > 0);
    return words.length === 0 || words.length >= minWords;
  }).join('\n');
}

// Detect if a line looks like a table row (mostly numbers, codes, or very short fields)
function isTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  // Lines that are mostly numbers/codes separated by spaces or pipes
  const codePattern = /^[\d\w]{1,10}(\s{2,}|\||\t)[\w\s]{1,50}$/;
  const pipeRow = /\|.+\|/;
  return codePattern.test(trimmed) || pipeRow.test(trimmed);
}

// Enrich table content with context so it embeds semantically
function enrichTableContent(text, sourceName, handbook) {
  const lines = text.split('\n');
  const enriched = [];
  let inTableBlock = false;
  let tableContext = '';
  let tableLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prevLine = i > 0 ? lines[i-1] : '';
    const nextLine = i < lines.length - 1 ? lines[i+1] : '';

    if (isTableRow(line)) {
      if (!inTableBlock) {
        inTableBlock = true;
        // Use preceding non-table line as context header
        tableContext = enriched.length > 0
          ? enriched[enriched.length - 1].trim()
          : `${sourceName} reference data`;
        tableLines = [];
      }
      tableLines.push(line.trim());
    } else {
      if (inTableBlock && tableLines.length > 0) {
        // Convert table block to natural language sentences
        const contextPrefix = tableContext
          ? `The following ${handbook} codes and values are from "${tableContext}":`
          : `The following codes appear in ${sourceName}:`;
        enriched.push(contextPrefix);
        tableLines.forEach(tl => {
          // Try to split code from description
          const parts = tl.split(/\s{2,}|\t|\|/).map(p => p.trim()).filter(Boolean);
          if (parts.length >= 2) {
            enriched.push(`Code ${parts[0]}: ${parts.slice(1).join(' ')}.`);
          } else {
            enriched.push(tl);
          }
        });
        enriched.push('');
        tableLines = [];
        inTableBlock = false;
        tableContext = '';
      }
      enriched.push(line);
    }
  }

  // Flush any remaining table lines
  if (inTableBlock && tableLines.length > 0) {
    const contextPrefix = tableContext
      ? `The following ${handbook} codes and values are from "${tableContext}":`
      : `The following codes appear in ${sourceName}:`;
    enriched.push(contextPrefix);
    tableLines.forEach(tl => {
      const parts = tl.split(/\s{2,}|\t|\|/).map(p => p.trim()).filter(Boolean);
      if (parts.length >= 2) {
        enriched.push(`Code ${parts[0]}: ${parts.slice(1).join(' ')}.`);
      } else {
        enriched.push(tl);
      }
    });
  }

  return enriched.join('\n');
}

// Convert bullet points and lists into complete sentences
function enrichListContent(text, sourceName) {
  return text
    // Bullet points → complete sentences
    .replace(/^[•·▪▸►‣⁃\-\*]\s+(.+)$/gm, (match, content) => {
      const trimmed = content.trim();
      // Already a sentence
      if (trimmed.endsWith('.') || trimmed.endsWith(':')) return trimmed;
      return trimmed + '.';
    })
    // Numbered lists — preserve but ensure sentence ending
    .replace(/^\d+[\.\)]\s+(.+)$/gm, (match, content) => {
      const trimmed = content.trim();
      if (trimmed.endsWith('.') || trimmed.endsWith(':')) return trimmed;
      return trimmed + '.';
    });
}

// Full enhanced cleaning pipeline
function enhancedClean(text, sourceName, handbook, config) {
  const {
    removePageNumbers = true,
    removeHeaders = true,
    collapseWhitespace = true,
    removeShortLinesEnabled = false,
    removeShortLinesMin = 5
  } = config;

  // Step 1: Basic noise removal
  if (removePageNumbers || removeHeaders || collapseWhitespace) {
    text = removePdfNoise(text);
  }

  // Step 2: Table enrichment — converts code tables to natural language
  text = enrichTableContent(text, sourceName, handbook);

  // Step 3: List enrichment — converts bullets to sentences
  text = enrichListContent(text, sourceName);

  // Step 4: Short line removal (optional)
  if (removeShortLinesEnabled) {
    text = removeShortLines(text, removeShortLinesMin);
  }

  // Step 5: Final whitespace cleanup
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}

function buildChunks(text, sourceName, handbook, category, chunkSize, chunkOverlap, minChunkWords, sourceLabel = '') {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    const content = words.slice(i, i + chunkSize).join(' ');
    const wordCount = content.split(/\s+/).length;
    if (wordCount >= minChunkWords) {
      // First chunk already has the full intro prepended by caller
      // Subsequent chunks get a short source label so every chunk carries context
      const chunkIndex = chunks.length;
      const finalContent = chunkIndex === 0
        ? content
        : (sourceLabel ? `[${sourceLabel}]\n${content}` : content);
      chunks.push({
        content: finalContent,
        metadata: {
          source: sourceName,
          handbook,
          category: category || handbook,
          chunkIndex,
          totalChunks: 0
        }
      });
    }
    i += chunkSize - chunkOverlap;
  }
  chunks.forEach(c => c.metadata.totalChunks = chunks.length);
  return chunks;
}

function buildGenericIntro(sourceName, handbook) {
  const topic = sourceName.includes(' — ') ? sourceName.split(' — ').slice(1).join(' — ').trim() : sourceName;
  const cat = sourceName.includes(' — ') ? sourceName.split(' — ')[0].trim() : handbook;
  return `This section covers ${topic} as part of the ${cat} category in the Santa Clara County ${handbook} handbook.\n\n`;
}

async function buildQuestionIntro(sourceName, handbook, sampleText) {
  try {
    const prompt = `Given this handbook section name and content sample, write 2-3 specific questions that a Santa Clara County eligibility worker would ask that this section directly answers. Be specific to the actual content.

Section: ${sourceName}
Handbook: ${handbook}
Content sample: ${sampleText.substring(0, 400)}

Respond with only the questions on one line separated by " | ". No preamble, no numbering, no extra text.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', // Sonnet for higher quality question intros
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    if (data.error || !data.content?.[0]) return buildGenericIntro(sourceName, handbook);
    const questions = data.content[0].text.trim();
    return `Workers commonly ask: ${questions}\n\n`;
  } catch (err) {
    console.error(`Question intro failed for "${sourceName}": ${err.message}`);
    return buildGenericIntro(sourceName, handbook);
  }
}

async function runOptimizationPipeline(sources, config, progressCallback) {
  const {
    chunkSize = 300,
    chunkOverlap = 50,
    minChunkWords = 30,
    introStyle = 'question',
    customTemplate = '',
    removePageNumbers = true,
    removeHeaders = true,
    collapseWhitespace = true,
    removeShortLinesEnabled = false,
    removeShortLinesMin = 5
  } = config;

  const allChunks = [];
  let processed = 0;

  for (const source of sources) {
    let text = source.raw_text || '';

    // Apply enhanced cleaning pipeline
    text = enhancedClean(text, source.name, source.handbook, config);

    if (!text.trim() || text.split(/\s+/).length < minChunkWords) {
      processed++;
      if (progressCallback) progressCallback(processed, sources.length, source.name, 0);
      continue;
    }

    // Build intro
    let intro = '';
    if (introStyle === 'generic') {
      intro = buildGenericIntro(source.name, source.handbook);
    } else if (introStyle === 'question') {
      intro = await buildQuestionIntro(source.name, source.handbook, text);
      await sleep(200); // avoid Claude rate limits
    } else if (introStyle === 'custom' && customTemplate) {
      const topic = source.name.includes(' — ') ? source.name.split(' — ').slice(1).join(' — ').trim() : source.name;
      intro = customTemplate.replace('{topic}', topic).replace('{handbook}', source.handbook).replace('{source}', source.name) + '\n\n';
    }

    const enriched = intro + text;
    // Build short label for continuation chunks (chunks after the first)
    const sourceLabel = `${source.handbook} — ${source.name}`;
    const chunks = buildChunks(enriched, source.name, source.handbook, source.metadata?.category || source.handbook, chunkSize, chunkOverlap, minChunkWords, sourceLabel);
    allChunks.push(...chunks);

    processed++;
    if (progressCallback) progressCallback(processed, sources.length, source.name, chunks.length);
  }

  return allChunks;
}

// ─── Strategy endpoints ─────────────────────────────────────────────────────

// List strategies
app.post('/api/admin/strategies', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const response = await fetch(supabaseUrl('optimization_strategies?select=*&order=created_at.desc'), {
      headers: supabaseHeaders()
    });
    const data = await response.json();
    res.json({ strategies: Array.isArray(data) ? data : [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Save strategy
app.post('/api/admin/strategies/save', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { name, handbook, config } = req.body;
  if (!name || !config) return res.status(400).json({ error: 'name and config required' });
  try {
    const result = await supabaseInsert('optimization_strategies', { name, handbook: handbook || null, config }, 'return=representation');
    res.json({ success: true, strategy: result[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update strategy
app.post('/api/admin/strategies/update', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { id, name, handbook, config } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    await fetch(supabaseUrl(`optimization_strategies?id=eq.${id}`), {
      method: 'PATCH',
      headers: supabaseHeaders({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ name, handbook: handbook || null, config })
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete strategy
app.post('/api/admin/strategies/delete', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { id } = req.body;
  try {
    await fetch(supabaseUrl(`optimization_strategies?id=eq.${id}`), { method: 'DELETE', headers: supabaseHeaders() });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Preview optimization (no DB changes)
app.post('/api/admin/optimize/preview', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { handbook, config } = req.body;
  if (!handbook || !config) return res.status(400).json({ error: 'handbook and config required' });
  try {
    // Fetch a sample of sources (first 5) for preview
    const response = await fetch(
      supabaseUrl(`raw_sources?handbook=eq.${encodeURIComponent(handbook)}&select=id,name,handbook,raw_text,metadata&limit=5`),
      { headers: supabaseHeaders() }
    );
    const sources = await response.json();
    if (!Array.isArray(sources) || sources.length === 0) return res.status(404).json({ error: `No sources found for handbook: ${handbook}` });

    // Get total source count
    const countRes = await fetch(
      supabaseUrl(`raw_sources?handbook=eq.${encodeURIComponent(handbook)}&select=count`),
      { headers: supabaseHeaders({ 'Prefer': 'count=exact', 'Range': '0-0' }) }
    );
    const countHeader = countRes.headers.get('content-range');
    const totalSources = countHeader ? parseInt(countHeader.split('/')[1]) : sources.length;

    // Run optimization on sample only (no Claude calls for preview speed)
    const previewConfig = { ...config, introStyle: config.introStyle === 'question' ? 'generic' : config.introStyle };
    const sampleChunks = await runOptimizationPipeline(sources, previewConfig, null);

    // Estimate total chunks
    const avgChunksPerSource = sampleChunks.length / sources.length;
    const estimatedTotal = Math.round(avgChunksPerSource * totalSources);

    // Build sample preview
    const sampleChunk = sampleChunks[0];
    const wordCounts = sampleChunks.map(c => c.content.split(/\s+/).length);
    const avgWords = wordCounts.length > 0 ? Math.round(wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length) : 0;

    res.json({
      totalSources,
      estimatedChunks: estimatedTotal,
      sampleChunksGenerated: sampleChunks.length,
      avgWordsPerChunk: avgWords,
      minWords: wordCounts.length > 0 ? Math.min(...wordCounts) : 0,
      maxWords: wordCounts.length > 0 ? Math.max(...wordCounts) : 0,
      sampleChunk: sampleChunk ? { source: sampleChunk.metadata.source, preview: sampleChunk.content.substring(0, 400) } : null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Run full optimization — safe sequence: generate all → delete old → insert new
app.post('/api/admin/optimize/run', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { handbook, config, strategyId } = req.body;
  if (!handbook || !config) return res.status(400).json({ error: 'handbook and config required' });

  // Get current chunk count for confirmation info
  const currentCountRes = await fetch(
    supabaseUrl(`documents?select=count&metadata->>handbook=eq.${encodeURIComponent(handbook)}`),
    { headers: supabaseHeaders({ 'Prefer': 'count=exact', 'Range': '0-0' }) }
  );
  const currentChunks = parseInt(currentCountRes.headers.get('content-range')?.split('/')[1] || '0');

  // Get source count
  const countRes = await fetch(
    supabaseUrl(`raw_sources?handbook=eq.${encodeURIComponent(handbook)}&select=count`),
    { headers: supabaseHeaders({ 'Prefer': 'count=exact', 'Range': '0-0' }) }
  );
  const totalSources = parseInt(countRes.headers.get('content-range')?.split('/')[1] || '0');

  if (totalSources === 0) return res.status(404).json({ error: `No raw sources found for handbook: ${handbook}` });

  // Respond immediately with full scope info
  res.json({ success: true, message: 'Optimization started', totalSources, currentChunks, handbook });

  // Run in background — SAFE SEQUENCE: generate all → delete → insert
  (async () => {
    try {
      console.log(`\n🔧 OPTIMIZATION START: ${handbook}`);
      console.log(`   Sources: ${totalSources} | Current chunks: ${currentChunks}`);
      console.log(`   Config: ${config.chunkSize}w/${config.chunkOverlap}o overlap | intro=${config.introStyle}`);

      // ── PHASE 1: Fetch all raw sources ─────────────────────────────────────
      let allSources = [];
      let offset = 0;
      const batchSize = 200;
      while (offset < totalSources) {
        const batchRes = await fetch(
          supabaseUrl(`raw_sources?handbook=eq.${encodeURIComponent(handbook)}&select=id,name,handbook,raw_text,metadata&order=name.asc&limit=${batchSize}&offset=${offset}`),
          { headers: supabaseHeaders({ 'Range': `${offset}-${offset + batchSize - 1}` }) }
        );
        const batch = await batchRes.json();
        if (!Array.isArray(batch) || batch.length === 0) break;
        allSources = allSources.concat(batch);
        offset += batchSize;
      }
      console.log(`📥 Fetched ${allSources.length} sources`);

      // ── PHASE 2: Generate ALL optimized chunks (no DB changes yet) ──────────
      console.log(`⚙️  Generating optimized chunks...`);
      const allChunks = await runOptimizationPipeline(allSources, config, (done, total, name, chunkCount) => {
        if (done % 25 === 0 || done === total) {
          console.log(`   Pipeline: ${done}/${total} sources | "${name}" → ${chunkCount} chunks`);
        }
      });
      console.log(`✅ Generated ${allChunks.length} optimized chunks from ${allSources.length} sources`);

      if (allChunks.length === 0) {
        console.error('❌ Optimization aborted — zero chunks generated. Raw sources may be empty. DB unchanged.');
        return;
      }

      // ── PHASE 3: Delete old chunks NOW (after generation succeeds) ──────────
      console.log(`🗑️  Deleting ${currentChunks} old ${handbook} chunks...`);
      await fetch(
        supabaseUrl(`documents?metadata->>handbook=eq.${encodeURIComponent(handbook)}`),
        { method: 'DELETE', headers: supabaseHeaders() }
      );
      console.log(`   Old chunks deleted`);

      // ── PHASE 4: Embed and insert new chunks immediately ────────────────────
      console.log(`📤 Embedding and inserting ${allChunks.length} new chunks...`);
      const { stored, errors } = await embedAndStoreChunks(allChunks, '[optimize]');

      // Rebuild handbook from raw_sources archive — no JSON needed
// This is the primary recovery and optimization path
app.post('/api/admin/rebuild-from-archive', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { handbook, config, clearFirst = true } = req.body;
  if (!handbook) return res.status(400).json({ error: 'handbook required' });

  // Use default config if none provided
  const effectiveConfig = config || {
    chunkSize: 300, chunkOverlap: 50, minChunkWords: 30,
    introStyle: 'generic', removePageNumbers: true,
    removeHeaders: true, collapseWhitespace: true,
    removeShortLinesEnabled: false, removeShortLinesMin: 5
  };

  // Get source count
  const countRes = await fetch(
    supabaseUrl(`raw_sources?handbook=eq.${encodeURIComponent(handbook)}&select=count`),
    { headers: supabaseHeaders({ 'Prefer': 'count=exact', 'Range': '0-0' }) }
  );
  const totalSources = parseInt(countRes.headers.get('content-range')?.split('/')[1] || '0');
  if (totalSources === 0) return res.status(404).json({ error: `No raw sources found for: ${handbook}` });

  // Get current chunk count
  const curCountRes = await fetch(
    supabaseUrl(`documents?select=count&metadata->>handbook=eq.${encodeURIComponent(handbook)}`),
    { headers: supabaseHeaders({ 'Prefer': 'count=exact', 'Range': '0-0' }) }
  );
  const currentChunks = parseInt(curCountRes.headers.get('content-range')?.split('/')[1] || '0');

  // Create job for tracking
  let jobId = null;
  try {
    jobId = await createJob('rebuild', `Rebuild ${handbook} from archive`, totalSources * 3, { handbook, config: effectiveConfig });
  } catch (err) { console.error('Job create failed:', err.message); }

  res.json({ success: true, message: `Rebuild started for ${handbook}`, totalSources, currentChunks, jobId });

  // Run in background
  (async () => {
    try {
      console.log(`\n🔄 REBUILD FROM ARCHIVE: ${handbook}`);
      console.log(`   Sources: ${totalSources} | Current chunks: ${currentChunks}`);

      // ── PHASE 1: Fetch all raw sources in batches ───────────────────────────
      let allSources = [];
      let offset = 0;
      const batchSize = 200;
      while (offset < totalSources) {
        const batchRes = await fetch(
          supabaseUrl(`raw_sources?handbook=eq.${encodeURIComponent(handbook)}&select=id,name,handbook,raw_text,metadata&order=name.asc&limit=${batchSize}&offset=${offset}`),
          { headers: supabaseHeaders({ 'Range': `${offset}-${offset + batchSize - 1}` }) }
        );
        const batch = await batchRes.json();
        if (!Array.isArray(batch) || batch.length === 0) break;
        allSources = allSources.concat(batch);
        offset += batchSize;
        console.log(`   Fetched ${allSources.length}/${totalSources} sources`);
      }

      // ── PHASE 2: Generate optimized chunks ─────────────────────────────────
      console.log(`⚙️  Generating chunks (${effectiveConfig.chunkSize}w/${effectiveConfig.chunkOverlap}o, intro=${effectiveConfig.introStyle})...`);
      const allChunks = await runOptimizationPipeline(allSources, effectiveConfig, (done, total, name, chunkCount) => {
        if (done % 50 === 0 || done === total) console.log(`   Pipeline: ${done}/${total} | "${name}" → ${chunkCount} chunks`);
      });
      console.log(`✅ Generated ${allChunks.length} chunks from ${allSources.length} sources`);

      if (allChunks.length === 0) {
        console.error('❌ Rebuild aborted — zero chunks generated. DB unchanged.');
        if (jobId) await updateJob(jobId, 0, 0, 'failed');
        return;
      }

      // ── PHASE 3: Delete existing chunks for this handbook (if requested) ────
      if (clearFirst) {
        console.log(`🗑️  Clearing existing ${handbook} chunks...`);
        await fetch(
          supabaseUrl(`documents?metadata->>handbook=eq.${encodeURIComponent(handbook)}`),
          { method: 'DELETE', headers: supabaseHeaders() }
        );
        console.log(`   Done`);
      }

      // ── PHASE 4: Embed and store new chunks ─────────────────────────────────
      console.log(`📤 Embedding ${allChunks.length} chunks...`);
      const { stored, errors } = await embedAndStoreChunks(allChunks, `[rebuild-${handbook}]`, jobId);

      console.log(`\n✅ REBUILD COMPLETE: ${handbook}`);
      console.log(`   ${stored} chunks stored | ${errors} errors`);
      if (errors > 0) console.log(`   ⚠️  Re-run to fill ${errors} missing chunks`);

    } catch (err) {
      console.error(`❌ REBUILD FAILED: ${err.message}`);
      if (jobId) await updateJob(jobId, 0, 0, 'failed');
    }
  })();
});
      if (strategyId) {
        await fetch(supabaseUrl(`optimization_strategies?id=eq.${strategyId}`), {
          method: 'PATCH',
          headers: supabaseHeaders({ 'Prefer': 'return=minimal' }),
          body: JSON.stringify({ last_run: new Date().toISOString(), last_run_chunks: stored })
        });
      }

      // ── PHASE 5: Update strategy last_run ──────────────────────────────────
      console.log(`   Old chunks: ${currentChunks} → New chunks: ${stored} | Errors: ${errors}`);
      if (errors > 0) console.log(`   ⚠️  ${errors} chunks failed to embed — re-run to fill gaps`);

    } catch (err) {
      console.error(`\n❌ OPTIMIZATION FAILED: ${err.message}`);
      console.error(`   Restore from snapshot if chunks are missing`);
    }
  })();
});
app.get('/admin', (req, res) => res.sendFile('dashboard.html', { root: 'public' }));
app.get('/dashboard', (req, res) => res.sendFile('dashboard.html', { root: 'public' }));
app.get('/data', (req, res) => res.sendFile('dashboard.html', { root: 'public' }));
app.get('/versions', (req, res) => res.sendFile('dashboard.html', { root: 'public' }));
app.get('/loader', (req, res) => res.sendFile('dashboard.html', { root: 'public' }));
app.get('*', (req, res) => res.sendFile('index.html', { root: 'public' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
