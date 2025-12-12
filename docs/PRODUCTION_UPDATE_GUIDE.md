# Production Environment Update Guide

## 📋 Overview

This guide explains how to update the production environment with data-pack-4 processing and blockchain recording.

## 🎯 Update Steps

### Step 1: Process and Upload Data Pack 4

Process the `data-pack-4.csv` file and create DataNFTs in the database:

```bash
node scripts/processAndUploadDataPack4.js
```

**What it does:**
- ✅ Reads and categorizes `data-pack-4.csv` by product category and region
- ✅ Groups data by category-region combinations
- ✅ Creates DataNFTs for each group with dynamic pricing
- ✅ Uses professional copywriting templates for descriptions
- ✅ Auto-publishes all DataNFTs
- ✅ Creates ~54 DataNFTs (depending on data distribution)

**Expected output:**
- Creates multiple DataNFTs grouped by category and region
- Each DataNFT has dynamic pricing based on record count
- All DataNFTs are automatically published

**Time estimate:** 2-5 minutes (depending on data size)

---

### Step 2: Update Data Pack Images

Update all data pack images to use the correct SVG files:

```bash
node scripts/updateDataPackImages.js
```

**What it does:**
- ✅ Finds all DataNFTs with `dataSource='upload'` (data packs)
- ✅ Checks if images are missing or using default values
- ✅ Extracts category from `dataRecords.category` or DataNFT name
- ✅ Matches category to corresponding SVG image
- ✅ Updates the `image` field in the database

**Expected output:**
- Updates all data pack images to `/data-pack/{Category} Data Pack.svg`
- Verifies all image files exist

**Time estimate:** < 1 minute

---

### Step 3: Record DataNFTs to Blockchain

Record all published DataNFTs to the blockchain:

```bash
node scripts/recordDataNFTToBlockchain.js --all
```

**What it does:**
- ✅ Finds all published DataNFTs that are not yet on-chain
- ✅ Records each DataNFT to the blockchain
- ✅ Generates unique token IDs
- ✅ Creates metadata URIs
- ✅ Updates database with blockchain information

**Prerequisites:**
- ✅ Backend wallet must be configured (`BACKEND_WALLET_PRIVATE_KEY` in `.env`)
- ✅ Backend wallet must have sufficient balance for gas fees (recommended: > 0.01 ETH)
- ✅ Network connection to blockchain RPC endpoint

**Expected output:**
- Records all unpublished DataNFTs to blockchain
- Each DataNFT gets a unique `blockchainTokenId` and `blockchainTxHash`
- Database is updated with blockchain information

**Time estimate:** 
- ~1-2 seconds per DataNFT
- For 140 DataNFTs: ~3-5 minutes

**Note:** The script includes rate limiting (500ms delay between transactions) to avoid overwhelming the network.

---

## 🔄 Complete Update Workflow

### Option A: Sequential Execution (Recommended)

```bash
# 1. Process data-pack-4.csv
node scripts/processAndUploadDataPack4.js

# 2. Update images
node scripts/updateDataPackImages.js

# 3. Record to blockchain
node scripts/recordDataNFTToBlockchain.js --all
```

### Option B: Automated Script

You can create a single script that runs all steps:

```bash
#!/bin/bash
# update-production.sh

echo "Step 1: Processing data-pack-4.csv..."
node scripts/processAndUploadDataPack4.js

echo "Step 2: Updating data pack images..."
node scripts/updateDataPackImages.js

echo "Step 3: Recording DataNFTs to blockchain..."
node scripts/recordDataNFTToBlockchain.js --all

echo "✅ Production update complete!"
```

---

## ⚙️ Environment Configuration

### Required Environment Variables

Make sure your `.env` file has:

```bash
# Database
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/datadance?schema=public"

# Blockchain
BACKEND_WALLET_PRIVATE_KEY="your-private-key-here"
DDC_CHAIN_RPC_URL="https://dev-exp-alpha.datadance.ai/eth/rpc"
DDC_CHAIN_ID=44508

# Metadata
METADATA_BASE_URL="https://api.datadance.ai"
```

### Backend Wallet Setup

If backend wallet is not configured:

```bash
node scripts/configureBackendWallet.js
```

This will:
- Generate or load backend wallet
- Display wallet address
- Check balance
- Save configuration to `.env`

---

## 📊 Verification Steps

### 1. Verify Data Pack Processing

```bash
node scripts/checkDataPackImages.js
```

**Expected:** All data packs have valid images

### 2. Verify Blockchain Status

```bash
node scripts/checkDataPackBlockchainStatus.js
```

**Expected:** All published DataNFTs are on-chain

### 3. Check Statistics

```bash
node scripts/checkStats.js
```

**Expected:** Shows updated DataNFT count and statistics

---

## 🚨 Troubleshooting

### Issue: Data Pack Processing Fails

**Possible causes:**
- CSV file not found
- Database connection error
- Invalid data format

**Solution:**
- Verify `data-pack-4.csv` exists in project root
- Check database connection: `node scripts/setupLocalDatabase.js`
- Review error messages in console

### Issue: Image Update Fails

**Possible causes:**
- SVG files missing
- Category detection fails

**Solution:**
- Verify SVG files exist in `public/data-pack/`
- Check script logs for category detection issues

### Issue: Blockchain Recording Fails

**Possible causes:**
- Backend wallet not configured
- Insufficient balance
- Network connection issues
- Contract address incorrect

**Solution:**
1. Check wallet configuration:
   ```bash
   node scripts/configureBackendWallet.js
   ```

2. Check wallet balance:
   ```bash
   # Should show balance > 0.01 ETH
   ```

3. Verify network connection:
   ```bash
   # Test RPC endpoint
   curl -X POST https://dev-exp-alpha.datadance.ai/eth/rpc \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
   ```

4. Check contract address in script configuration

### Issue: Transaction Fails

**Possible causes:**
- Gas price too low
- Network congestion
- Contract method error

**Solution:**
- Wait and retry
- Check transaction on blockchain explorer
- Review error messages for specific issues

---

## 📝 Pre-Production Checklist

Before running in production:

- [ ] Backup database
- [ ] Verify backend wallet has sufficient balance (> 0.1 ETH recommended)
- [ ] Test scripts in staging environment first
- [ ] Verify all SVG image files exist
- [ ] Check network connectivity to blockchain RPC
- [ ] Review `.env` configuration
- [ ] Ensure `data-pack-4.csv` is ready
- [ ] Schedule maintenance window if needed

---

## 🔍 Post-Update Verification

After running all scripts, verify:

1. **Data Pack Count:**
   ```bash
   node scripts/checkDataPackBlockchainStatus.js
   ```
   Should show all DataNFTs are on-chain

2. **Image Status:**
   ```bash
   node scripts/checkDataPackImages.js
   ```
   Should show all images are valid

3. **Database Records:**
   ```bash
   node scripts/checkStats.js
   ```
   Should show updated statistics

4. **Blockchain Explorer:**
   - Check transaction hashes on blockchain explorer
   - Verify token IDs are sequential
   - Confirm metadata URIs are accessible

---

## 📚 Related Scripts

- `scripts/processAndUploadDataPack4.js` - Process and upload data-pack-4
- `scripts/updateDataPackImages.js` - Update data pack images
- `scripts/recordDataNFTToBlockchain.js` - Record to blockchain
- `scripts/checkDataPackImages.js` - Check image status
- `scripts/checkDataPackBlockchainStatus.js` - Check blockchain status
- `scripts/checkStats.js` - View statistics
- `scripts/setupLocalDatabase.js` - Test database connection
- `scripts/configureBackendWallet.js` - Configure backend wallet

---

## ⏱️ Estimated Total Time

- **Data Pack Processing:** 2-5 minutes
- **Image Update:** < 1 minute
- **Blockchain Recording:** 3-5 minutes (for ~140 DataNFTs)
- **Total:** ~6-11 minutes

---

## 🎯 Quick Reference

```bash
# Complete update workflow
node scripts/processAndUploadDataPack4.js && \
node scripts/updateDataPackImages.js && \
node scripts/recordDataNFTToBlockchain.js --all

# Verification
node scripts/checkDataPackBlockchainStatus.js
```
