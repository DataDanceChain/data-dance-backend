# Referral / Redemption Fraud Audit

**Date:** 2026-05-29  
**Environment audited:** Production (`8.217.68.148`)  
**Trigger:** Suspicious volume of referral points and Google Form redemption requests with no corresponding product usage (uploads).

---

## Executive Summary

A coordinated referral-farming operation exploited the pre-fix referral rules: invitees received `REFERRAL_DIRECT` (+150 pts) **immediately on signup**, with **no requirement for a valid upload**. Redeemers had large point balances built entirely from referrals while having **zero `crawlerData` uploads**.

| Layer | Scope | Key finding |
|-------|--------|-------------|
| Platform | ~1,673 standard referrals | **0/1,673 invitees have any upload** |
| In-app redemptions | 7 unique users, 21,400 pts | All referral-heavy, **0 uploads** |
| Invitee deep-dive | 431 invitees of 7 redeemers | **0 uploads**, mostly 1 check-in + small task claims |
| Google Form (rows 13–86) | 74 submissions, 69 emails | **74/74 HIGH risk**, **0 uploads**, 163,500 pts requested |

**Recommendation:** Reject all pending Google Form rows 12–86; do not pay duplicate or already-redeemed submissions. Referral rewards were temporarily disabled, then re-enabled with stricter rules (first valid upload required). Historical point clawback is a separate product/legal decision.

---

## Investigation Timeline

### 1. Kill switch (referral rewards)

**Goal:** Stop further abuse while investigating.

| Surface | Flag | Effect |
|---------|------|--------|
| Backend | `DISABLE_REFERRAL_REWARDS_FEATURES=true` | Blocks `/api/referrals/*`, strips referral from awards/tasks |
| Frontend build | `VITE_DISABLE_REFERRAL_REWARDS=true` | Hides referral UI in Rewards hub |

Deployed to production, verified, then **re-enabled** after rule changes (see § Remediation).

### 2. Rule and logic hardening

**Goal:** Align product rules with anti-abuse intent.

- **Copy:** `referralCopy.ts` / `referralCopy.js` — rewards only after invitee’s first valid upload; Welcome Bonus partial unlock for invited users; anti-abuse contact text.
- **Backend:** `firstValidUpload.js` — valid upload = any `crawlerData` row.
- **`referralService.js`:** Defer `REFERRAL_DIRECT` until invitee first upload; idempotent via `sourceId = inviteeId`; hook from `crawlerService.js`.
- **`taskService.js`:** Invited users’ welcome bonus requires first upload; referral task progress uses qualified invite counts.

### 3. In-app redemption audit

**Script:** `scripts/auditRedemptions.js`

Queried all `REWARD_REDEMPTION` point records and built per-user profiles: uploads, points by source, referral counts, inviter/invitee links.

**Result:**

| Metric | Value |
|--------|-------|
| Redemption records | 8 |
| Unique redeemers | 7 |
| Total points redeemed | 21,400 |
| Redeemers with 0 uploads | **7/7** |
| Primary point source | `REFERRAL_DIRECT` (10–112 invites × 150 pts) |

**Known redeemers (all flagged):**

- oxmdshifat@gmail.com  
- hralpin22@gmail.com  
- vaik1625@gmail.com  
- monxcataa@gmail.com  
- donfilex459@gmail.com  
- denz.eldee008@gmail.com  
- sakibr1997sakib@gmail.com  

### 4. Platform-wide referral stats

**Script:** `scripts/auditRedemptionNetworks.js` (and ad-hoc production queries)

| Metric | Value |
|--------|-------|
| Standard referrals (`campaignSlug = null`) | ~1,673 |
| `REFERRAL_DIRECT` payouts | ~1,672 |
| Invitees with any upload | **0 / 1,673** |
| Users platform-wide with `crawlerData` | 9 (internal/test; none are redeemers) |

This confirms the issue is **systemic**, not limited to a few bad actors.

### 5. Invitee activity audit (431 invitees)

**Script:** `scripts/auditInviteeActivity.js`  
**Export:** `scripts/output/redeemer-invitee-activity.csv`

For all invitees of the 7 in-app redeemers:

| Signal | Finding |
|--------|---------|
| Uploads | **0 / 431** |
| Crawler points | **0** |
| Check-ins | ~400 did exactly 1 check-in |
| Task claims | ~428 claimed small welcome/task points (5–8 pts) |
| Registration timing | **430/431** registered at the **exact same millisecond** as referral creation |
| Sub-farm nodes | 5 accounts under donfilex459 / hralpin22 (including denz.eldee008, sakibr1997sakib) that also invite others |

**Conclusion:** Invitees exhibit bot/farm patterns, not real product usage.

### 6. Google Form redemption verification

**Source CSV:** `未命名的表单 (Responses) - Form Responses 1.csv`  
**Script:** `scripts/verifyFormRedemptions.js`  
**Export:** `scripts/output/form-redemptions-verified.csv`  
**Scope:** Form rows **13–86** (user noted “13 行往下都是要兑奖的”); row **12** audited separately — same pattern.

**Run on production** with CSV at `/tmp/form-redemptions.csv` (2026-05-29).

#### Summary (rows 13–86)

| Metric | Value |
|--------|-------|
| Form submissions | 74 |
| Unique emails | 69 |
| Found in DB | 74/74 |
| Balance sufficient | 74/74 |
| Uploads | **0/74** |
| Risk HIGH | **74/74** |
| Total points if all approved | **163,500** |
| Duplicate submissions (same email twice) | 5 |

#### Risk flags (all 74 rows)

Every row matched: `NO_UPLOAD` | `HIGH_REFERRAL` | `MASS_INVITER` | `REFERRAL_NO_UPLOAD`

#### Already redeemed in app — do not pay again via form

| Row | Email | Form request | Already redeemed (app) |
|-----|-------|--------------|------------------------|
| 13 | donfilex459@gmail.com | 2,000 | 2,000 |
| 19 | hralpin22@gmail.com | 3,600 | 3,600 |
| 26 | monxcataa@gmail.com | 3,600 | 3,600 |
| 39, 42 | oxmdshifat@gmail.com | 3,600 × 2 | 5,100 |
| 47, 48 | vaik1625@gmail.com | 3,600 × 2 | 3,600 |

5 users, 7 form rows — **22,800 pts** in duplicate claims.

#### Duplicate form submissions (reject 2nd entry)

| Row | Email | Note |
|-----|-------|------|
| 17 | workrafsty@gmail.com | Row 16 already submitted |
| 42 | oxmdshifat@gmail.com | Row 39 + already app-redeemed |
| 48 | vaik1625@gmail.com | Row 47 + already app-redeemed |
| 73 | afrannn2@gmail.com | Row 72 already submitted |
| 76 | jekoma92@gmail.com | Row 75 already submitted |

#### If paying unique emails once (never app-redeemed only)

Still **64 users**, **133,900 points** — all HIGH risk, zero uploads. **Not recommended.**

#### Farm topology

**Head nodes (large $25 / 3,600 pt requests):**

| Row | Email | Direct invites | Balance | Uploads |
|-----|-------|----------------|---------|---------|
| 26 | monxcataa@gmail.com | 112 | 13,293 | 0 |
| 39 | oxmdshifat@gmail.com | 84 | 12,672 | 0 |
| 47 | vaik1625@gmail.com | 88 | 9,694 | 0 |
| 19 | hralpin22@gmail.com | 84 | 9,406 | 0 |
| 65 | mimbosu57@gmail.com | 79 | 11,909 | 0 |
| 68 | boxmeet8@gmail.com | 79 | 11,909 | 0 |
| 66 | jdu8291@gmail.com | 71 | 10,703 | 0 |
| 86 | kcximran@gmail.com | 63 | 9,500 | 0 |

**Leaf template:** ~45 accounts with **exactly 14 invites**, ~2,107 balance, 0 uploads — bulk $10 Mastercard (2,000 pt) requests (~90,000 pts total).

**donfilex459 subtree (from row 13 onward):**

- Row 13: donfilex459 (root; already app-redeemed, resubmitted)
- Row 14: msomalike368 ← donfilex459
- Row 15: kiskog358 ← donfilex459
- Row 16: workrafsty ← lewisjupiter38 (downstream of donfilex network)

Shared X handle **@backcome053** on row 14 (msomalike) and row 11 (denz.eldee008).

**rafidakmal92 subtree:** workrafid3, cantikkempus, dandiuu11, akunkita.112, rafidsetya60, akmalsugar — same pattern.

#### Row 12 (borderline — same batch, earlier timestamp)

| Field | Value |
|-------|-------|
| Email | jubitawaleti@gmail.com |
| Invited by | donfilex459@gmail.com |
| Invites | 15 |
| Uploads | 0 |
| Balance | 2,257 |
| App redeemed | No |
| Risk | HIGH |

Treat the same as rows 13+.

#### Row 85 — wallet / email mismatch

| Field | Value |
|-------|-------|
| Email | sajedakhaton328@gmail.com |
| Wallet in form | `0x71f37…` (same as row 9 sakibr1997sakib) |
| Wallet in DB for this email | `0x33388…` |
| Invites | 10 |
| Uploads | 0 |

**Manual review required.** Do not pay to the form wallet address.

#### Form rows 1–11 (context, outside “13+” scope)

Includes legitimate internal test (race@enjoymusic.ai) and early submissions from core farm accounts (oxmdshifat, donfilex459, hralpin22, vaik1625, monxcataa, denz.eldee008, sakibr1997sakib) before the May 26–27 burst.

---

## Methodology

### Data sources

- Production PostgreSQL via Prisma (`User`, `Point`, `Referral`, `CrawlerData`)
- Google Form export CSV
- In-app `REWARD_REDEMPTION` ledger

### Audit scripts

| Script | Purpose |
|--------|---------|
| `scripts/auditRedemptions.js` | All in-app redemptions + redeemer profiles |
| `scripts/auditRedemptionNetworks.js` | Referral network / platform-wide stats |
| `scripts/auditInviteeActivity.js` | Per-invitee activity for known redeemers |
| `scripts/verifyFormRedemptions.js` | Cross-check form CSV vs DB (`[csvPath] [startRow]`) |

### Risk scoring (`verifyFormRedemptions.js`)

- **HIGH:** `MASS_INVITER` (≥10 direct invites) or `HIGH_REFERRAL` (≥5 `REFERRAL_DIRECT` records)
- Common flags: `NO_UPLOAD`, `REFERRAL_NO_UPLOAD`

### Production verification command

```bash
# Copy form CSV to server
scp "未命名的表单 (Responses) - Form Responses 1.csv" root@8.217.68.148:/tmp/form-redemptions.csv

# Run inside API container
docker exec ddc-backend-ddc-backend-api-1 \
  node /app/scripts/verifyFormRedemptions.js /tmp/form-redemptions.csv 13
```

---

## Remediation Already Deployed

1. **Referral kill switch** — toggled off during investigation, then re-enabled after fixes.
2. **Deferred `REFERRAL_DIRECT`** — only after invitee’s first valid upload.
3. **Welcome bonus gating** for invited users — requires first upload.
4. **User-visible rules** updated (frontend + backend copy).
5. **API gate** — `referralRewardsApiGate.js` for future emergency disable.

---

## Operational Recommendations

### Google Form payouts

| Action | Scope |
|--------|--------|
| **Reject** | Rows 12–86 (all HIGH risk, zero uploads) |
| **Do not double-pay** | donfilex459, hralpin22, monxcataa, oxmdshifat, vaik1625 (already app-redeemed) |
| **Ignore duplicate rows** | 17, 42, 48, 73, 76 |
| **Manual review** | Row 85 sajedakhaton328 (wallet mismatch) |

### Suggested rejection reason (template)

> Account activity shows mass referral farming with no valid data uploads. Referral rewards require invitees to complete a first valid upload per current program rules. This submission does not meet eligibility.

### Open decisions (not implemented)

- **Historical clawback** of ~250k+ `REFERRAL_DIRECT` points issued under old rules
- **Wallet / device / IP clustering** for law-enforcement or account bans
- **Automated form validation** against DB flags before manual payout

---

## Artifacts

| File | Description |
|------|-------------|
| `scripts/output/form-redemptions-verified.csv` | Per-row form verification (rows 13–86) |
| `scripts/output/redeemer-invitee-activity.csv` | 431 invitees of 7 in-app redeemers |
| `scripts/auditRedemptions.js` | In-app redemption audit |
| `scripts/auditRedemptionNetworks.js` | Network-level stats |
| `scripts/auditInviteeActivity.js` | Invitee deep-dive |
| `scripts/verifyFormRedemptions.js` | Form CSV cross-check |
| `src/middlewares/referralRewardsApiGate.js` | Emergency referral API gate |
| `src/utils/firstValidUpload.js` | Upload qualification helper |

---

## Appendix: Point economics (rough)

| Channel | Users / rows | Points |
|---------|----------------|--------|
| Already redeemed in app | 7 | 21,400 |
| Form rows 13–86 (if all paid) | 74 submissions | 163,500 |
| Form unique, never app-redeemed (if paid once each) | 64 | 133,900 |
| Platform `REFERRAL_DIRECT` (historical, pre-fix) | ~1,672 events | ~250k+ (order of magnitude) |

Combined exposure if form batch were approved on top of existing redemptions would be **~$1,600+ USD equivalent** in gift cards from this form slice alone, with **no verified product usage** from redeemers or their invitees.

---

*Generated from production audit work, 2026-05-26 – 2026-05-29.*
