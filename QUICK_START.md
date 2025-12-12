# Quick Start Guide - Data Pack 4 Processing

## ✅ What's Been Set Up

1. **Processing Script**: `scripts/processAndUploadDataPack4.js`
   - Categorizes data by product category and region
   - Creates DataNFTs with dynamic pricing
   - Uses professional copywriting templates

2. **Database Setup Script**: `scripts/setupLocalDatabase.js`
   - Tests database connection
   - Verifies configuration

3. **Database Connection**: ✅ Verified and working
   - Connected to `datadance-postgres` container
   - Database: `datadance` on `localhost:5432`

## 🚀 Quick Start

### Step 1: Verify Database Connection

```bash
node scripts/setupLocalDatabase.js
```

Expected output:
```
✅ Database connection successful!
✅ Database is ready to use!
```

### Step 2: Process and Upload Data Pack 4

```bash
node scripts/processAndUploadDataPack4.js
```

This will:
- ✅ Read `data-pack-4.csv` (138,734 records)
- ✅ Categorize by product category and region
- ✅ Create DataNFTs for each category-region group
- ✅ Apply dynamic pricing based on record count
- ✅ Use professional descriptions from templates
- ✅ Auto-publish all DataNFTs

### Step 3: Check Results

```bash
# View statistics
node scripts/checkStats.js

# Or use Prisma Studio to browse DataNFTs
npm run prisma:studio
```

## 📊 Dynamic Pricing

Prices are calculated based on record count:
- **0-100 records**: $25-50
- **101-500 records**: $50-100
- **501-1,000 records**: $100-200
- **1,001-5,000 records**: $200-400
- **5,000+ records**: $400-800

## 📝 Copywriting Templates

Each DataNFT uses category-specific descriptions:
- Health & Wellness
- Home & Kitchen
- Automotive
- Books & Media
- Beauty & Personal Care
- Baby & Kids
- Electronics
- Fashion & Apparel
- Sports & Outdoors
- Other

## 🔧 Troubleshooting

**Database connection issues?**
```bash
# Test connection
node scripts/setupLocalDatabase.js

# Check .env file has correct DATABASE_URL
# DATABASE_URL="postgresql://postgres:postgres@localhost:5432/datadance?schema=public"
```

**Script errors?**
- Make sure `data-pack-4.csv` exists in the project root
- Verify database is running: Check Docker Desktop → `datadance-postgres` container
- Run migrations if needed: `npm run prisma:migrate`

## 📚 More Information

See `docs/LOCAL_SETUP_GUIDE.md` for detailed setup instructions.
