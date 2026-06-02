# Referral Fraud Investigation — Full Report (No Code Changes)

**Data snapshot:** Production DB, queried **2026-05-29** via existing audit scripts  
**Scope:** Google Form rows **13–86** (74 submissions, 69 unique emails) + context from **431 invitees** of 7 in-app redeemers  
**Note:** Production SSH was **unreachable** when this report was refreshed; registration times and profiles below come from the last successful production export merged into local CSVs.

---

## Deliverables (open in Excel / Sheets)

| File | Contents |
|------|----------|
| [`scripts/output/form-redemptions-full-profile.csv`](../scripts/output/form-redemptions-full-profile.csv) | **74 rows — one line per form submission** with **registered_at**, points breakdown, inviter, recommendation |
| [`scripts/output/form-redemptions-verified.csv`](../scripts/output/form-redemptions-verified.csv) | Risk flags, dup form, already redeemed |
| [`scripts/output/redeemer-invitee-activity.csv`](../scripts/output/redeemer-invitee-activity.csv) | **431 invitees** — reg time, check-in, hub visit, task pts, uploads |
| [`docs/REFERRAL_FRAUD_AUDIT.md`](REFERRAL_FRAUD_AUDIT.md) | Process timeline + operational recommendations |

---

## 1. What we could pull **without code changes**

| Category | Field | Source | Form batch (74) | Invitee deep-dive (431) |
|----------|-------|--------|-----------------|---------------------------|
| Identity | Email, wallet | `User` | ✅ | ✅ |
| **Registration time** | `User.createdAt` | `User` | ✅ | ✅ |
| Referral link time | `Referral.createdAt` | `Referral` | Partial (invited_by only) | ✅ (= reg time for 430/431) |
| Points | By source | `Point` | ✅ | ✅ |
| Uploads | Count | `CrawlerData` | ✅ 0/74 | ✅ 0/431 |
| Check-in | Count | `UserDailyEvent` CHECK_IN | ❌ not in export* | ✅ |
| Rewards Hub visit | Count | `UserDailyEvent` REWARDS_HUB_VISIT | ❌ not in export* | ✅ |
| Task claim total | Sum | `Point` TASK_CLAIM | ✅ | ✅ |
| First task claim delay | Point.createdAt − reg | `Point` | ❌ needs re-query | ❌ |
| Inviter tree | inviter email | `Referral` | ✅ (6 with known inviter) | ✅ |
| App redemption history | REWARD_REDEMPTION | `Point` | ✅ | — |
| Registration IP | — | Not stored | ❌ | ❌ |
| Device / UA / timezone | — | Not stored | ❌ | ❌ |
| Page path / session | — | Not stored | ❌ | ❌ |
| Referral link copy event | — | Not stored | ❌ | ❌ |
| Failed upload attempts | — | Not persisted | ❌ | ❌ |

\*Two form accounts (rows 14–15) overlap the invitee CSV and show check-in there.

---

## 2. Registration time — form batch (rows 13–86)

### By day (UTC)

| Date | Accounts registered |
|------|---------------------|
| 2026-05-10 | 2 (oxmdshifat duplicate form rows) |
| 2026-05-20 | 1 (hralpin22) |
| 2026-05-21 | 5 (donfilex network + vaik1625) |
| 2026-05-24 | 1 (monxcataa) |
| **2026-05-26** | **49** ← main burst |
| 2026-05-27 | 16 |

**63 / 74** registered **≤ 1 day** before submitting the Google Form.

### May 26 hourly burst (UTC)

Peak hours: **18:00 (7 accounts)**, **17:00 (6)**, **21:00 (6)**, **11:00 (5)**, **15–16:00 (5 each)**.  
Pattern: farm registers many leaf accounts on **May 26**, then **mass form submission May 26–27**.

### Head nodes — registration vs form submit

| Row | Email | Registered (UTC) | Form submit | Days gap | Invites | Balance |
|-----|-------|------------------|-------------|----------|---------|---------|
| 26 | monxcataa | 2026-05-24 20:27 | 5/26 23:12 | 2.1 | 112 | 13,293 |
| 47 | vaik1625 | 2026-05-21 20:49 | 5/27 03:18 | 5.3 | 88 | 9,694 |
| 19 | hralpin22 | 2026-05-20 09:03 | 5/26 21:01 | 6.5 | 84 | 9,406 |
| 39 | oxmdshifat | 2026-05-10 17:40 | 5/27 02:15 | 16.4 | 84 | 12,672 |
| 65 | mimbosu57 | 2026-05-26 15:04 | 5/27 07:33 | 0.7 | 79 | 11,909 |
| 68 | boxmeet8 | 2026-05-26 17:15 | 5/27 09:27 | 0.7 | 79 | 11,909 |
| 66 | jdu8291 | 2026-05-26 17:11 | 5/27 08:53 | 0.7 | 71 | 10,703 |
| 86 | kcximran | 2026-05-26 17:34 | 5/31 12:52 | 4.8 | 63 | 9,500 |
| 13 | donfilex459 | 2026-05-21 08:37 | 5/26 15:13 | 5.3 | 24 | 3,560 |

### Leaf template

**47 accounts** with exactly **14 direct invites** and ~**2,107** balance — classic sub-farm redeemers asking for **$10 Mastercard (2000 pts)**.

### Same-millisecond registration (among form submitters themselves)

Only **5 pairs** (duplicate form emails share one account): workrafsty, oxmdshifat, vaik1625, afrannn2, jekoma92.

Among **their 431 invitees**, **430/431** have `registered_at === referred_at` (same millisecond).

---

## 3. Per-account full profile

**Every row 13–86** is in [`form-redemptions-full-profile.csv`](../scripts/output/form-redemptions-full-profile.csv) with columns:

`row`, `form_submit_at`, `email`, `reward`, `points_requested`, `balance`, **`registered_at`**, `days_reg_to_form`, `invited_by`, `direct_invites`, `uploads`, `referral_direct_pts`, `task_claim_pts`, `crawler_pts`, `already_redeemed_db`, `earned_total`, `wallet_db`, `risk`, `dup_form`, **`recommendation`**, `flags`

### Recommendation codes

| Code | Count | Meaning |
|------|-------|---------|
| REJECT_FRAUD_PROFILE | 62 | HIGH risk, 0 uploads, referral farm |
| REJECT_ALREADY_REDEEMED | 7 rows (5 users) | Paid in app, form resubmit |
| REJECT_DUPLICATE_FORM | 5 | Same email submitted twice |

---

## 4. Row 12 (jubitawaleti) — same batch, earlier form line

Not in rows 13–86 CSV export; verified separately on production **2026-05-29**:

| Field | Value |
|-------|-------|
| Email | jubitawaleti@gmail.com |
| Invited by | donfilex459@gmail.com |
| Invites | 15 |
| Uploads | 0 |
| Balance | 2,257 |
| Risk | HIGH |
| App redeemed | No |
| X handle | breklink21 |

Registration timestamp: re-query when SSH is available (not in cached JSON).

---

## 5. Invitee layer (431 people under 7 redeemers)

From [`redeemer-invitee-activity.csv`](../scripts/output/redeemer-invitee-activity.csv):

| Metric | Value |
|--------|-------|
| Any upload | **0 / 431** |
| Any crawler points | **0** |
| ≥1 check-in | 400 (93%) |
| Rewards Hub visit | 322 (75%) |
| Task claim points | 428 (99%) |
| Reg time = referral time (ms) | **430 / 431** |
| Heuristic “likely real user” | **0** |

**Typical script path:** register → 1 check-in → small welcome/daily task (5–8 pts) → +150 to inviter → never upload.

---

## 6. Cross-links

| Form row | Email | Also in invitee CSV as donfilex459’s invitee |
|----------|-------|-----------------------------------------------|
| 14 | msomalike368 | ✅ 1 check-in |
| 15 | kiskog358 | ✅ 3 check-ins |

---

## 7. Points economics (unchanged)

| Scenario | Points |
|----------|--------|
| All 74 form rows approved | 163,500 |
| Unique 69 emails, dedupe, exclude already app-redeemed | 133,900 |
| Already redeemed in app (do not pay again) | 22,800 across 7 duplicate form rows |

---

## 8. Final conclusion (no code changes needed to decide)

1. **All 74 form rows 13–86:** reject — 0 uploads, referral-only balances, HIGH flags.
2. **Registration timing** confirms automation: **49 accounts on May 26 UTC alone**; most form submits within **hours to 1 day** of registration.
3. **431 invitee audit** confirms downstream accounts are not real product users.
4. **Cannot prove IP/device/link-copy** without logs or new instrumentation — not required to justify rejection given upload + referral evidence.

---

## 9. Refresh when SSH works

```bash
scp "Form Responses.csv" root@8.217.68.148:/tmp/form-redemptions.csv
docker exec ddc-backend-ddc-backend-api-1 \
  node /app/scripts/verifyFormRedemptions.js /tmp/form-redemptions.csv 13
docker exec ddc-backend-ddc-backend-api-1 \
  node /app/scripts/auditInviteeActivity.js
```

Optional one-off for check-in on form emails (no repo changes):

```bash
docker exec ddc-backend-ddc-backend-api-1 node -e '
const prisma=require("./src/utils/prisma");
(async()=>{ /* query UserDailyEvent + Point first TASK_CLAIM per user */ })();
'
```

---

*Generated from existing production audit exports — no application code was modified.*
