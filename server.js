const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const HANDBOOK_CONTEXT = `You are an expert assistant for the Santa Clara County Medi-Cal Handbook, maintained by the Department of Employment and Benefits Services (DEBS) at stgenssa.sccgov.org.

The Medi-Cal Handbook covers:
- Eligibility requirements (income, residency, citizenship, age groups)
- Aid codes (e.g., 39, 3T, 54/5W, 38, 45, etc.)
- Application and enrollment processes including Accelerated Enrollment (AE)
- Annual renewals, Continuous Coverage Unwinding (CCU) period guidance
- Retroactive Medi-Cal (3-month retroactive coverage)
- Medical support enforcement (referrals to DCSS, exceptions for pregnant women, etc.)
- E-signatures and telephonic signatures — counties must accept e-signatures on all Medi-Cal forms
- Foster Care Medi-Cal (FC EW responsibilities, MC 250, MC 210A forms, aid code 45)
- Covered California transitions and Automatic Plan Enrollment
- MAGI budgeting, RPAI (Reasonably Projected Annual Income), budget periods
- CalHEERS and CalSAWS system processing
- Continuous Eligibility for children under 19 (12-month protection period after AE)

Key policies:
- Accelerated Enrollment (AE): Temporary no-cost full-scope Medi-Cal during application processing. Children 19 and under get 12-month continuous eligibility protection.
- E-signatures: As of 2025, counties MUST accept e-signatures on any forms required for Medi-Cal, including from third parties like CBOs.
- Retroactive Medi-Cal: Up to 3 months before application date can be covered with completed MC 210A form.
- Medical support referrals: NOT required for pregnant women until end of 365-day postpartum period.
- CCU Period: June 2023–December 2024 guidance; negative actions delayed until scheduled renewal month.

Always answer based on this handbook's guidance. If something is outside your knowledge, say so clearly and suggest checking: https://stgenssa.sccgov.org/debs/program_handbooks/medi-cal/index.htm

Be clear, concise, and professional. Use bullet points for lists. If referencing a specific chapter or section, mention it.`;

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid request: messages array required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        system: HANDBOOK_CONTEXT,
        messages
      })
    });

    const data = await response.json();

    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    res.json({ reply: data.content[0].text });

  } catch (err) {
    console.error('Claude API error:', err);
    res.status(500).json({ error: 'Failed to reach Claude API' });
  }
});

// Catch-all: serve the frontend
app.get('*', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
