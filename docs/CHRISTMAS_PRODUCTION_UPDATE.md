# Christmas Features - Production Environment Update Guide

## Overview

This guide provides step-by-step instructions for updating the production environment with the Christmas Welcome Bonus and Christmas Badge features.

---

## Prerequisites

1. **Database Access**: Ensure you have access to the production PostgreSQL database
2. **Backend Access**: SSH access to the production server
3. **Backup**: Always backup the database before running any scripts
4. **Environment Variables**: Ensure `.env` file has correct `DATABASE_URL` for production

---

## Step 1: Backup Database

```bash
# Create a backup before making changes
pg_dump -h <PRODUCTION_DB_HOST> -U <DB_USER> -d <DB_NAME> > backup_$(date +%Y%m%d_%H%M%S).sql
```

---

## Step 2: Pull Latest Code

```bash
# Navigate to backend directory
cd /path/to/data-dance-backend

# Pull latest changes from wallet-pass branch
git fetch origin
git checkout wallet-pass
git pull origin wallet-pass
```

---

## Step 3: Install Dependencies (if needed)

```bash
npm install
```

---

## Step 4: Run Database Migrations (if any)

```bash
# Check for pending migrations
npx prisma migrate status

# Apply migrations if needed
npx prisma migrate deploy
```

---

## Step 5: Create Christmas Badge and Tasks

**This is the main script that creates all required data:**

```bash
# Set production database URL
export DATABASE_URL="postgresql://<USER>:<PASSWORD>@<HOST>:<PORT>/<DATABASE>?schema=public"

# Run the setup script
node scripts/setupChristmasBadge.js
```

**What this script does:**
1. ✅ Creates all awards and tasks from `config/awards.json`
2. ✅ Creates DDC organization user (if not exists)
3. ✅ Creates Christmas Badge (`christmas-badge-2025`)
4. ✅ Creates Christmas Shopping Award (`christmas-shopping`)
5. ✅ Creates three tasks:
   - `upload-3-orders` - Upload 3+ December Orders
   - `follow-x` - Follow X (Twitter)
   - `join-telegram` - Join Telegram

**Expected Output:**
```
🎄 Setting up Christmas Badge and Tasks...

Creating all awards and tasks from awards.json...
✅ Award definitions seeded.
✅ Task definitions seeded.

✅ DDC organization already exists: DataDance

✅ Christmas Badge already exists, updated: Exclusive DDC Christmas Badge

✅ Christmas Shopping Award already exists: Christmas Shopping

✅ Task already exists, updated: Upload 3+ December Orders (upload-3-orders)
✅ Task already exists, updated: Follow X (Twitter) (follow-x)
✅ Task already exists, updated: Join Telegram (join-telegram)

✅ Setup completed successfully!
```

---

## Step 6: Verify Badge Image

Ensure the badge image exists at:
```
public/assets/badges/ddc-2025-christmas.png
```

If the image doesn't exist, upload it to the server:
```bash
# Upload the image file
scp public/assets/badges/ddc-2025-christmas.png <SERVER_USER>@<SERVER_HOST>:/path/to/backend/public/assets/badges/
```

---

## Step 7: Restart Backend Service

```bash
# Restart the backend service (adjust command based on your setup)
pm2 restart data-dance-backend
# OR
systemctl restart data-dance-backend
# OR
docker-compose restart backend
```

---

## Step 8: Verify API Endpoints

Test the new endpoints to ensure they work:

### 1. Check Christmas Welcome Bonus Status
```bash
curl -X GET "https://<YOUR_API_DOMAIN>/api/users/christmas-welcome-bonus/status" \
  -H "Authorization: Bearer <JWT_TOKEN>"
```

### 2. Test Verify X Follow
```bash
curl -X POST "https://<YOUR_API_DOMAIN>/api/users/christmas-shopping/verify-x-follow" \
  -H "Authorization: Bearer <JWT_TOKEN>" \
  -H "Content-Type: application/json"
```

### 3. Test Verify Telegram Join
```bash
curl -X POST "https://<YOUR_API_DOMAIN>/api/users/christmas-shopping/verify-telegram-join" \
  -H "Authorization: Bearer <JWT_TOKEN>" \
  -H "Content-Type: application/json"
```

### 4. Check Badges API
```bash
curl -X GET "https://<YOUR_API_DOMAIN>/api/assets/badges" \
  -H "Authorization: Bearer <JWT_TOKEN>"
```

---

## Step 9: Verify Database Records

Check that all records were created correctly:

```sql
-- Check Christmas Badge
SELECT * FROM "Badge" WHERE id = 'christmas-badge-2025';

-- Check Christmas Shopping Award
SELECT * FROM "Award" WHERE id = 'christmas-shopping';

-- Check Christmas Tasks
SELECT id, title, "awardId", status FROM "Task" WHERE "awardId" = 'christmas-shopping';
```

**Expected Results:**
- 1 Badge record
- 1 Award record
- 3 Task records (upload-3-orders, follow-x, join-telegram)

---

## Rollback Plan

If something goes wrong:

1. **Restore Database Backup:**
   ```bash
   psql -h <PRODUCTION_DB_HOST> -U <DB_USER> -d <DB_NAME> < backup_<TIMESTAMP>.sql
   ```

2. **Revert Code:**
   ```bash
   git checkout <previous_commit_hash>
   npm install
   pm2 restart data-dance-backend
   ```

---

## Troubleshooting

### Issue: Script fails with "Task not found"
**Solution:** Ensure `config/awards.json` exists and is valid JSON

### Issue: Badge image not found
**Solution:** Upload the image file to `public/assets/badges/ddc-2025-christmas.png`

### Issue: API returns 404 for new endpoints
**Solution:** 
1. Verify routes are registered in `src/routes/userRoutes.js`
2. Restart the backend service
3. Check server logs for errors

### Issue: Tasks not showing in frontend
**Solution:**
1. Verify tasks exist in database
2. Check that `awardId` is `christmas-shopping`
3. Verify task `status` is `LIVE`
4. Check frontend API calls match the documentation

---

## Summary Checklist

- [ ] Database backup created
- [ ] Latest code pulled from `wallet-pass` branch
- [ ] Dependencies installed (`npm install`)
- [ ] Database migrations applied (if any)
- [ ] `setupChristmasBadge.js` script executed successfully
- [ ] Badge image uploaded to server
- [ ] Backend service restarted
- [ ] API endpoints tested and working
- [ ] Database records verified
- [ ] Frontend integration tested

---

## Quick Reference

**Main Script:**
```bash
node scripts/setupChristmasBadge.js
```

**Key Database Records:**
- Badge ID: `christmas-badge-2025`
- Award ID: `christmas-shopping`
- Task IDs: `upload-3-orders`, `follow-x`, `join-telegram`

**API Endpoints:**
- `GET /api/users/christmas-welcome-bonus/status`
- `POST /api/users/christmas-welcome-bonus/claim`
- `POST /api/users/christmas-shopping/verify-x-follow`
- `POST /api/users/christmas-shopping/verify-telegram-join`
- `GET /api/assets/badges`
- `POST /api/assets/badges/christmas-badge-2025/collect`

---

## Support

If you encounter any issues during the update process, check:
1. Server logs: `pm2 logs data-dance-backend` or `docker logs <container>`
2. Database connection: Verify `DATABASE_URL` in `.env`
3. API documentation: `docs/CHRISTMAS_BADGE_API.md`

