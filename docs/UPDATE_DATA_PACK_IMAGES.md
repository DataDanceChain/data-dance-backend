# Update Data Pack Images Script

## Overview

This script automatically updates images for all data pack DataNFTs in the database by matching their category to the corresponding SVG image file.

## Features

- ✅ Finds all DataNFTs with `dataSource='upload'` (data packs)
- ✅ Checks if images are missing or using default values
- ✅ Extracts category from `dataRecords.category` or DataNFT name
- ✅ Matches category to corresponding SVG image
- ✅ Updates the `image` field in the database
- ✅ Verifies all image files exist
- ✅ Provides detailed statistics

## Category to Image Mapping

| Category | Image File |
|----------|-----------|
| Automotive | `/data-pack/Automotive Data Pack.svg` |
| Baby & Kids | `/data-pack/Baby & Kids Data Pack.svg` |
| Beauty & Personal Care | `/data-pack/Beauty & Personal Care Data Pack.svg` |
| Books & Media | `/data-pack/Books & Media Data Pack.svg` |
| Electronics | `/data-pack/Electronics Data Pack.svg` |
| Fashion & Apparel | `/data-pack/Fashion & Apparel Data Pack.svg` |
| Health & Wellness | `/data-pack/Health & Wellness Data Pack.svg` |
| Home & Kitchen | `/data-pack/Home & Kitchen Data Pack.svg` |
| Sports & Outdoors | `/data-pack/Sports & Outdoors Data Pack.svg` |
| Other | `/data-pack/Other Data Pack.svg` |

## Usage

```bash
node scripts/updateDataPackImages.js
```

## How It Works

1. **Fetches all data pack DataNFTs** from the database
2. **Checks each DataNFT**:
   - If image is already set (not default), skips it
   - If image is default or missing, proceeds to update
3. **Extracts category**:
   - Primary: From `dataRecords.category` field
   - Fallback: From DataNFT name (pattern matching)
4. **Matches to image**: Uses category to find corresponding SVG path
5. **Updates database**: Sets the `image` field to the correct SVG path
6. **Verifies files**: Checks that all SVG files exist in `public/data-pack/`

## Default Images That Will Be Replaced

The script will update DataNFTs with these default/missing images:
- `/assets/nfts/data-pack-default.jpg`
- `/assets/nfts/data-pack-default.png`
- `null` or `undefined`
- Empty string `''`

## Category Detection

### Primary Method: From dataRecords
```javascript
dataRecords.category  // e.g., "Electronics"
```

### Fallback Method: From Name
The script can extract category from DataNFT names like:
- `"Electronics Data Pack - North America"`
- `"Fashion & Apparel Data Pack - Europe"`
- `"Home & Kitchen - Asia"`

It also uses keyword matching:
- "automotive", "car", "vehicle" → Automotive
- "baby", "kids", "infant" → Baby & Kids
- "beauty", "cosmetic", "makeup" → Beauty & Personal Care
- etc.

## Example Output

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🖼️  Data Pack Image Updater
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📦 Fetching all data pack DataNFTs...
✅ Found 54 data pack DataNFTs

🔍 Processing DataNFTs...

✅ Updated: Electronics Data Pack - North America
   Category: Electronics
   Image: /data-pack/Electronics Data Pack.svg

✅ Updated: Fashion & Apparel Data Pack - Europe
   Category: Fashion & Apparel
   Image: /data-pack/Fashion & Apparel Data Pack.svg

...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✨ Update Complete!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 Statistics:
   Total DataNFTs: 54
   Needed Update: 54
   Successfully Updated: 54
   Skipped (already has image): 0
   Errors: 0

📦 Updates by Category:
   Electronics: 8
   Fashion & Apparel: 7
   Home & Kitchen: 6
   ...
```

## Requirements

1. **Image Files**: All SVG files must exist in `public/data-pack/` directory
2. **Database Connection**: `.env` file must have correct `DATABASE_URL`
3. **Category Information**: DataNFTs should have category in `dataRecords.category` or in their name

## Troubleshooting

### Error: "Image file not found"
- Check that SVG files exist in `public/data-pack/` directory
- Verify file names match exactly (case-sensitive)
- Ensure file permissions allow reading

### Error: "No category found"
- DataNFT doesn't have category in `dataRecords.category`
- Name doesn't contain recognizable category keywords
- Script will use "Other" category as fallback

### No DataNFTs Updated
- All DataNFTs already have non-default images
- No DataNFTs with `dataSource='upload'` found
- Check database for data pack DataNFTs

## Notes

- The script is **idempotent**: Safe to run multiple times
- It only updates DataNFTs with default/missing images
- Already configured images are skipped
- All updates are logged for verification
