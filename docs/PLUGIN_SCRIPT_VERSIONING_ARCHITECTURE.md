# Plugin Script Versioning System - Architecture & API Design

## Overview

A version management system for plugin scripts that allows:
- Dynamic script updates without plugin redeployment
- Multi-platform support (Amazon, Airbnb, Booking, Luma, etc.)
- Multi-client support (different client tags/endpoints)
- Version tracking and rollback capabilities
- External script upload (for development/testing)

---

## Core Concepts

### 1. Platform
The data source platform (e.g., `amazon`, `airbnb`, `booking`, `luma`)

### 2. Client Tag
The client/endpoint identifier (e.g., `chrome-extension`, `firefox-addon`, `desktop-app`, `mobile-app`)

### 3. Version
Script version number (semantic versioning: `major.minor.patch`, e.g., `1.0.0`)

### 4. Script Content
The actual JavaScript code that the plugin executes

---

## Database Schema Design

### PluginScript Model

```prisma
model PluginScript {
  id          String   @id @default(uuid())
  platform    String   // 'amazon', 'airbnb', 'booking', 'luma'
  clientTag   String   // 'chrome-extension', 'firefox-addon', etc.
  version     String   // Semantic version: '1.0.0', '1.1.0', etc.
  script      String   // The actual JavaScript code
  description String?  // Optional description of changes
  isActive    Boolean  @default(true) // Whether this version is active
  isLatest    Boolean  @default(false) // Whether this is the latest version
  metadata    Json?    @default("{}") // Additional metadata (author, changelog, etc.)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  createdBy   String?  // Optional: who created this version

  @@unique([platform, clientTag, version])
  @@index([platform, clientTag, isLatest])
  @@index([platform, clientTag, isActive])
}
```

### Indexes
- `(platform, clientTag, version)` - Unique constraint
- `(platform, clientTag, isLatest)` - Fast lookup for latest version
- `(platform, clientTag, isActive)` - Fast lookup for active versions

---

## API Endpoints

### 1. Get Latest Script

**Endpoint:** `GET /api/plugin-scripts/latest`

**Query Parameters:**
- `platform` (required): Platform ID (`amazon`, `airbnb`, `booking`, `luma`)
- `clientTag` (required): Client tag (`chrome-extension`, `firefox-addon`, etc.)

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "version": "1.2.0",
    "script": "// Plugin script content\n(function() { ... })();",
    "metadata": {
      "description": "Updated Amazon order extraction logic",
      "changelog": "Fixed order ID parsing issue",
      "author": "dev-team"
    },
    "checksum": "sha256:abc123...", // Optional: for integrity verification
    "updatedAt": "2025-12-15T10:00:00Z"
  }
}
```

**Response (404 Not Found):**
```json
{
  "status": "error",
  "message": "No script found for platform 'amazon' and clientTag 'chrome-extension'"
}
```

---

### 2. Check Script Version

**Endpoint:** `GET /api/plugin-scripts/check-version`

**Query Parameters:**
- `platform` (required): Platform ID
- `clientTag` (required): Client tag
- `currentVersion` (required): Current version the plugin has

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "currentVersion": "1.1.0",
    "latestVersion": "1.2.0",
    "isUpToDate": false,
    "updateAvailable": true,
    "updateUrl": "/api/plugin-scripts/latest?platform=amazon&clientTag=chrome-extension"
  }
}
```

**If up to date:**
```json
{
  "status": "success",
  "data": {
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "currentVersion": "1.2.0",
    "latestVersion": "1.2.0",
    "isUpToDate": true,
    "updateAvailable": false
  }
}
```

---

### 3. Get Script by Version

**Endpoint:** `GET /api/plugin-scripts/version`

**Query Parameters:**
- `platform` (required): Platform ID
- `clientTag` (required): Client tag
- `version` (required): Specific version to retrieve

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "version": "1.1.0",
    "script": "// Plugin script content\n(function() { ... })();",
    "metadata": {
      "description": "Initial Amazon script",
      "changelog": "First release"
    },
    "isActive": true,
    "isLatest": false,
    "createdAt": "2025-12-10T10:00:00Z",
    "updatedAt": "2025-12-10T10:00:00Z"
  }
}
```

---

### 4. List All Versions

**Endpoint:** `GET /api/plugin-scripts/versions`

**Query Parameters:**
- `platform` (required): Platform ID
- `clientTag` (required): Client tag
- `includeInactive` (optional, default: false): Include inactive versions

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "versions": [
      {
        "version": "1.2.0",
        "isLatest": true,
        "isActive": true,
        "description": "Updated Amazon order extraction logic",
        "createdAt": "2025-12-15T10:00:00Z"
      },
      {
        "version": "1.1.0",
        "isLatest": false,
        "isActive": true,
        "description": "Fixed order parsing",
        "createdAt": "2025-12-12T10:00:00Z"
      },
      {
        "version": "1.0.0",
        "isLatest": false,
        "isActive": true,
        "description": "Initial release",
        "createdAt": "2025-12-10T10:00:00Z"
      }
    ]
  }
}
```

---

### 5. Upload Script (External)

**Endpoint:** `POST /api/plugin-scripts/upload`

**Note:** Currently no authentication required (for development/testing)

**Request Body:**
```json
{
  "platform": "amazon",
  "clientTag": "chrome-extension",
  "version": "1.3.0",
  "script": "// Plugin script content\n(function() { ... })();",
  "description": "Optional description of changes",
  "metadata": {
    "changelog": "Added support for new Amazon order format",
    "author": "dev-team",
    "tested": true
  },
  "setAsLatest": true, // Whether to set this as the latest version
  "setAsActive": true  // Whether to activate this version
}
```

**Response (201 Created):**
```json
{
  "status": "success",
  "data": {
    "id": "script-uuid",
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "version": "1.3.0",
    "isLatest": true,
    "isActive": true,
    "createdAt": "2025-12-16T10:00:00Z"
  }
}
```

**Response (400 Bad Request):**
```json
{
  "status": "error",
  "message": "Version already exists for this platform and clientTag"
}
```

---

### 6. Update Script Status

**Endpoint:** `PUT /api/plugin-scripts/:id/status`

**Path Parameters:**
- `id`: Script ID

**Request Body:**
```json
{
  "isActive": false,  // Optional: activate/deactivate
  "setAsLatest": true // Optional: set as latest version
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "id": "script-uuid",
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "version": "1.2.0",
    "isLatest": true,
    "isActive": false,
    "updatedAt": "2025-12-16T10:00:00Z"
  }
}
```

---

### 7. List All Platforms and Client Tags

**Endpoint:** `GET /api/plugin-scripts/platforms`

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "platforms": [
      {
        "id": "amazon",
        "name": "Amazon",
        "clientTags": ["chrome-extension", "firefox-addon"],
        "latestVersions": {
          "chrome-extension": "1.2.0",
          "firefox-addon": "1.1.0"
        }
      },
      {
        "id": "airbnb",
        "name": "Airbnb",
        "clientTags": ["chrome-extension"],
        "latestVersions": {
          "chrome-extension": "1.0.0"
        }
      }
    ]
  }
}
```

---

## Business Logic Flow

### Plugin Activation Flow

```
1. Plugin starts/activates
   ↓
2. Plugin checks current version (stored locally)
   ↓
3. Plugin calls: GET /api/plugin-scripts/check-version
   Parameters: platform, clientTag, currentVersion
   ↓
4. Backend responds:
   - If isUpToDate: true → Plugin uses local script
   - If updateAvailable: true → Plugin downloads new script
   ↓
5. Plugin calls: GET /api/plugin-scripts/latest
   Parameters: platform, clientTag
   ↓
6. Backend returns latest script content
   ↓
7. Plugin:
   - Validates script (optional: checksum verification)
   - Saves script locally
   - Updates local version number
   - Executes script
```

### Script Update Flow

```
1. Developer uploads new script via POST /api/plugin-scripts/upload
   ↓
2. Backend:
   - Validates version format (semantic versioning)
   - Checks for duplicate version
   - Stores script in database
   - If setAsLatest: true
     → Marks previous latest as isLatest: false
     → Marks new version as isLatest: true
   - If setAsActive: true
     → Sets isActive: true
   ↓
3. Next time plugin checks version:
   - Detects new version available
   - Downloads and updates automatically
```

### Version Management

**Latest Version Logic:**
- Only ONE version per (platform, clientTag) can be `isLatest: true`
- When setting a new version as latest:
  1. Find current latest version
  2. Set `isLatest: false` on current latest
  3. Set `isLatest: true` on new version

**Active Version Logic:**
- Multiple versions can be `isActive: true` (for rollback capability)
- When deactivating a version:
  - Set `isActive: false`
  - If it was the latest, find the most recent active version and set as latest

**Version Rollback:**
- Admin can set any active version as latest
- Plugin will automatically download the new "latest" version

---

## Data Flow Diagram

```
┌─────────────┐
│   Plugin    │
│  (Client)   │
└──────┬──────┘
       │
       │ 1. Check Version
       ├─────────────────┐
       │                 │
       │ 2. Get Latest   │
       │    (if needed)  │
       │                 │
       ▼                 ▼
┌─────────────────────────────┐
│      Backend API            │
│  /api/plugin-scripts/*      │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│    PluginScript Service     │
│  - Version checking         │
│  - Script retrieval         │
│  - Version management       │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│      Database               │
│  PluginScript Table         │
└─────────────────────────────┘
```

---

## Implementation Considerations

### 1. Version Format
- Use semantic versioning: `major.minor.patch`
- Examples: `1.0.0`, `1.1.0`, `2.0.0`
- Validation: Regex pattern `^\d+\.\d+\.\d+$`

### 2. Script Validation
- Optional: JavaScript syntax validation
- Optional: Size limits (e.g., max 1MB)
- Optional: Checksum generation (SHA256) for integrity

### 3. Performance
- Cache latest versions in memory (Redis optional)
- Index on (platform, clientTag, isLatest) for fast queries
- Consider CDN for script delivery (future enhancement)

### 4. Security (Future)
- Add authentication for upload endpoint
- Rate limiting on upload endpoint
- Script sanitization/validation
- Content Security Policy headers

### 5. Monitoring
- Track script download counts
- Track version adoption rates
- Log script errors (if plugin reports back)

---

## Example Use Cases

### Use Case 1: Plugin First Activation

```
1. Plugin installed, no local version
2. Plugin calls: GET /api/plugin-scripts/latest?platform=amazon&clientTag=chrome-extension
3. Backend returns: version 1.2.0, script content
4. Plugin saves locally and executes
```

### Use Case 2: Plugin Update Check

```
1. Plugin has version 1.1.0 locally
2. Plugin calls: GET /api/plugin-scripts/check-version?platform=amazon&clientTag=chrome-extension&currentVersion=1.1.0
3. Backend responds: updateAvailable=true, latestVersion=1.2.0
4. Plugin downloads new script
5. Plugin updates local version to 1.2.0
```

### Use Case 3: Developer Uploads New Script

```
1. Developer calls: POST /api/plugin-scripts/upload
   Body: { platform: "amazon", clientTag: "chrome-extension", version: "1.3.0", script: "...", setAsLatest: true }
2. Backend:
   - Validates version format
   - Checks for duplicates
   - Stores script
   - Sets previous latest (1.2.0) to isLatest: false
   - Sets new version (1.3.0) to isLatest: true
3. Next plugin check will detect 1.3.0 as latest
```

### Use Case 4: Rollback to Previous Version

```
1. Admin calls: PUT /api/plugin-scripts/:id/status
   Body: { setAsLatest: true }
   Where id is version 1.1.0
2. Backend:
   - Sets current latest (1.3.0) to isLatest: false
   - Sets 1.1.0 to isLatest: true
3. Next plugin check will download 1.1.0
```

---

## Database Migration

```sql
CREATE TABLE "PluginScript" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "platform" TEXT NOT NULL,
  "clientTag" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "script" TEXT NOT NULL,
  "description" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "isLatest" BOOLEAN NOT NULL DEFAULT false,
  "metadata" JSONB DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdBy" TEXT,
  
  CONSTRAINT "PluginScript_platform_clientTag_version_key" UNIQUE ("platform", "clientTag", "version")
);

CREATE INDEX "PluginScript_platform_clientTag_isLatest_idx" ON "PluginScript"("platform", "clientTag", "isLatest");
CREATE INDEX "PluginScript_platform_clientTag_isActive_idx" ON "PluginScript"("platform", "clientTag", "isActive");
```

---

## API Summary Table

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `/api/plugin-scripts/latest` | Get latest script | No |
| GET | `/api/plugin-scripts/check-version` | Check if update available | No |
| GET | `/api/plugin-scripts/version` | Get specific version | No |
| GET | `/api/plugin-scripts/versions` | List all versions | No |
| GET | `/api/plugin-scripts/platforms` | List platforms and client tags | No |
| POST | `/api/plugin-scripts/upload` | Upload new script | No (for now) |
| PUT | `/api/plugin-scripts/:id/status` | Update script status | No (for now) |

---

## Next Steps

1. ✅ Create database migration
2. ✅ Implement Prisma schema
3. ✅ Create service layer (`pluginScriptService.js`)
4. ✅ Create controller (`pluginScriptController.js`)
5. ✅ Create routes (`pluginScriptRoutes.js`)
6. ✅ Add validation middleware
7. ✅ Add error handling
8. ✅ Add logging
9. ✅ Write tests
10. ⚠️ Add authentication (future)
11. ⚠️ Add rate limiting (future)
12. ⚠️ Add script validation (future)

---

## Notes

- **No authentication for now**: As requested, upload endpoint is open (for development/testing)
- **Version format**: Strict semantic versioning (major.minor.patch)
- **Latest version**: Only one latest per (platform, clientTag) combination
- **Active versions**: Multiple active versions allowed (for rollback)
- **Script size**: Consider adding size limits in future
- **CDN**: Consider CDN for script delivery if traffic is high
