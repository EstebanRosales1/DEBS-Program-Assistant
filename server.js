const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const HANDBOOK_CONTEXT = `You are an expert assistant for the Santa Clara County Medi-Cal Handbook, maintained by the Department of Employment and Benefits Services (DEBS). You have been trained on the actual handbook content below. Always answer based on this content. If a question falls outside what is covered here, say so clearly and direct the user to: https://stgenssa.sccgov.org/debs/program_handbooks/medi-cal/index.htm

Be clear, concise, and professional. Use bullet points for lists. Always mention which section your answer comes from.

---
## SECTION 1: MEDI-CAL HIERARCHY
Source: MC_Hierarchy.htm

Federal law specifies that individuals must be evaluated for medical coverage programs in a specific order:

### 1. Mega Mandatory
- SSI/SSP: Aid codes 10, 20, 60
- Title IV-E Adoption Assistance: 03, 07
- State-Only Adoption Assistance: 09, 4A
- MC-only Adoption Assistance: 04
- Title IV-E Foster Care: 42, 49
- State-Only Foster Care: 40, 43, 4K, 5K, 5L
- MC-only Foster Care: 45, 46
- Former Foster Care: 4M
- Title IV-E KinGap: 4F, 4S, 4T
- State-Only KinGap: 4G, 4W
- Pickle: 16, 26, 66
- Disabled Adult Child (DAC): 6A, 6C
- Disabled Widow/Widower: 36
- Medicare Savings Programs: QMB (80), SLMB (8C), QI-1 (8D), QWDI (8A)

### 2. MAGI MC
- Full-scope MAGI MC (children/infants): M5, P4, P7, P8 (also 30, 31, 32, 33, 35, 3A-3W series)
- Full-scope Optional Targeted Low Income: T1, T2, T3, T5
- Parent/Caretaker Relative Full-scope: M3
- Parent/Caretaker Relative Restricted-scope: M4
- Pregnant Woman Citizen/LPR: M7, M9
- Pregnant Woman Undocumented: M8, M0
- New Adult Group Full-scope: M1
- New Adult Group Restricted-scope: M2
- Disabled/blind no Medicare ≤128% FPL Full-scope: L6
- Disabled/blind no Medicare ≤128% FPL Restricted-scope: L7

### 3. Other Coverage for Children and Pregnant Women
- MCAP Pregnant Women: 0D, 0G
- MCAP linked infant/children: E6, E7
- CCHIP (Santa Clara County participates): 2C

### 4. Non-MAGI MC (Optional Categorical)
- Aged & Disabled FPL Full-scope: 1H, 6H
- Aged & Disabled FPL Restricted-scope: 1U, 6U
- Blind FPL Program: 2H
- 250% Working Disabled Program: 6G
- Tuberculosis Program: 7H

### 5. Non-MAGI MC (Medically Needy/Medically Indigent)
- ABD MN Full-scope Zero SOC: 14, 24, 64
- ABD MN Full-scope Share-of-Cost: 17, 27, 67
- Long Term Care Full-scope: 13, 23, 63
- MI Child Full-scope: 82 / SOC: 83
- MI Pregnant Woman Full-scope: 86 / SOC: 87
- Federal BCCTP Full-scope: 0P, 0W / Restricted: 0L, 0U, 0V

### 6. Non-MAGI MC (State Only)
- State BCCTP: 0N, 0R, 0T, 0X, 0Y
- MI Long Term Care State only: 53
- Dialysis Only Program: 71
- Total Parenteral Nutrition: 73
- Anti-Rejection Medicine: 77
- 365-Day Postpartum: 76

---
## SECTION 2: MAGI MC DETAILS
Source: MAGIMC.htm

MAGI MC evaluates eligibility based on income, residency and household (tax filing household and relationship). If no Mega Mandatory eligibility exists, evaluate for MAGI MC.

- Effective July 1, 2022: premiums no longer imposed for OTLICP, MCAP, and CCHIP.
- Children: includes biological, step, and/or adopted children.
- Parent/Caretaker Relative: relative of dependent child under 19, by blood, adoption, or marriage.
- Pregnant Women/Infants: evaluated with higher FPL limits.
- Expanded MC (New Adult Group): childless adults 19-64 not aged/blind/disabled became eligible under ACA 2014.
- Disabled/blind in New Adult Group with income ≤128% FPL and no Medicare: aid code L6 (full) or L7 (restricted).
- OTLICP: children with family income 160%-266% FPL eligible for full-scope MC.
- MCAP: health coverage for pregnant women and infants.
- CCHIP: available in San Mateo, San Francisco, and Santa Clara counties. Higher income limits than MAGI MC. Citizens, nationals, and LPR children under 19. Note: SB75 does not apply to CCHIP.

---
## SECTION 3: NON-MAGI MC DETAILS
Source: NonMAGIMC.htm

Non-MAGI MC is determined only after an individual has been found ineligible for Mega Mandatory and MAGI MC.

- ABD FPL Program: for aged/disabled individuals. Optional — not required by federal law but California offers it.
- 250% WDP: for working individuals with disabilities.
- Tuberculosis Program: limited services.
- Medically Needy (MN): allows aged (65+), blind, or disabled individuals who exceed income limits to spend down excess income on medical expenses (Share of Cost) to become eligible.
- AFDC MC: established by parent/caretaker relative living with and caring for child/children.
- Long Term Care (LTC): provides personal care services. If individual is in Non-MAGI Optional Categorical group, LTC will require transition to MN program with potential SOC.
- BCCTP: provides cancer treatment to eligible individuals diagnosed with breast and/or cervical cancer by Cancer Detection Programs like Every Woman Counts (EWC) or Family PACT.

---
## SECTION 4: AFFORDABLE CARE ACT & COVERED CALIFORNIA
Source: ACA.htm

- ACA signed into law March 23, 2010.
- Covered CA established as California's Health Benefit Exchange.
- Insurance companies cannot deny applicants with pre-existing conditions.
- No annual or lifetime limits on benefits.
- Dependents up to age 26 may remain on parent's employer-sponsored plan.
- All plans must cover preventive care with no copayments for in-network providers.
- California reinstated individual mandate effective January 1, 2020; penalties paid to Franchise Tax Board.
- California State Subsidy effective January 1, 2020: available through Covered CA.
  - 400-600% FPL: average $172/household/month savings.
  - 200-400% FPL: average $15/household/month savings.
  - Under 138% FPL: benchmark plan lowered to $1/member/month.
- Metal tiers: Bronze, Silver, Gold, Platinum (and Catastrophic plan).

---
## SECTION 5: COVERED CA BUDGETING
Source: Budgeting.htm

- Budget includes all countable income and allowable deductions compared to FPL based on tax filing household size.
- QHP: Applicants may purchase unsubsidized QHP at full cost. No MAGI MC, APTC, or CSR evaluation if client doesn't request financial assistance.
- APTC: For income 139%-400% FPL. APTC pays the gap between full cost of second-lowest Silver plan and applicant's max monthly portion.
- CSR/Enhanced Silver: For income 139%-250% FPL. Must sign up for Silver plan. Cannot have CSR without APTC.
  - Silver 94: $75 individual deductible, $5 PCP copay
  - Silver 87: $550 individual deductible, $15 PCP copay
  - Silver 73: $1,900 individual deductible, $40 PCP copay
- Applicants filing Married Filing Separately or who received APTC last year but didn't file taxes: ineligible for APTC/CSR but can purchase QHP at full price.

---
## SECTION 6: TRANSITIONING FROM COVERED CA TO MEDI-CAL
Source: Transitioning_from_Covered_CA_to_MC.htm

- Covered CA clients transition to MC due to annual renewal completion or reported changes.
- Covered CA processes renewals starting in October each year.
- Clients must complete renewal within 34 days of annual renewal notice.
- If renewal not completed by day 34: Covered CA re-enrolls client in last selected plan or equivalent.
- If reported changes result in termination of APTC subsidized plan, an ERD is sent to county for processing.
- If change occurred in current month: client can keep APTC until end of year or be evaluated for MAGI immediately.

---
## SECTION 7: AUTOMATIC PLAN ENROLLMENT (SB 260)
Source: Auto_Plan_enrollment.htm

SB 260 requires Covered CA to automatically enroll individuals transitioning from MAGI MC, CCHIP, MCAP, and MCAIP into the lowest silver Covered CA plan.

Eligibility for Auto-Enrollment:
- MAGI MC beneficiaries with income increases above MAGI limits, or children who aged out.
- CCHIP children who aged out, moved out of CCHIP counties, or income increased above CCHIP limit.
- MCAP individuals no longer eligible for MCAP.
- MCAIP infants with income increases at first annual renewal or reaching age 2.

Process:
- SSBS must review case for all MC programs (CPPs and Non-MAGI) prior to discontinuance.
- SSBS may release Soft Pause if beneficiary clearly states verbally or in writing they do not want Non-MAGI evaluation.
- If ineligible for all MC including CPPs, individual receives "MC 239 Over Income" NOA and transitions to Covered CA.
- Qualifying individuals receive current program discontinuance notice AND Covered CA "NOD01T" notice.
- To avoid gap in coverage: individual must select plan in same month as MC discontinuance date.
- Individuals have until end of first month of coverage to complete enrollment by paying premium, accepting $0 net premium terms, or choosing another plan.
- SB 260 dedicated phone line: 1-800-816-4725.

Exceptions to SB 260 Auto-Plan:
- AI/AN individuals placed in lowest cost AI/AN health plan.
- Individuals with family members already on Covered CA may be enrolled in existing plan.

Special Enrollment Period: 60-day SEP due to loss of Minimum Essential Coverage (MEC).

---
## SECTION 8: 2026 POLICY UPDATES

### Update 2026-1: California Residency (Effective 2/23/26)
Source: Medi-Cal_Update_2026-1
Reference: ACWDL 26-04

- Beginning February 23, 2026: California residency verifications MUST be provided for ALL Medi-Cal applicants.
- The State Waiver that previously allowed approval without proof of residency NO LONGER applies.
- If residency is electronically verified for primary applicant, verification applies to ALL household members.
- If primary applicant's residency is NOT electronically verified, acceptable verifications must be provided for ALL adult household members.
- IMPORTANT: Verification of residency is NOT required for children.
- CalHEERS programmed to electronically verify residency starting 2/23/26.

### Update 2026-2: American Indian/Alaska Native Property Exemptions (Effective immediately, 3/26/26)
Source: Medi-Cal_Update_2026-2
Reference: MEDIL I 26-08

- Additional property exemptions for AI/AN tribe members in non-MAGI determinations.
- Exempt resource types:
  - Payments/distributions under Public Law 90-507, 92-254, and section 6 of Public Law 87-775.
  - Resources from judgments by Indian Claims Commission or Court of Claims.
  - Distributions from shares of stock/income from trust lands if kept in separate identifiable account and not co-mingled.
- Updated section: Period of Unavailability in Chapter 19 (Property).
- Affects Medi-Cal program only.
`;

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
        messages: messages.slice(-6)
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

app.get('*', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
