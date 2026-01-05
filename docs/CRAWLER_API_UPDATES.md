# Crawler API Updates - Frontend Integration Guide

## Overview

The crawler task system has been updated to support new data sources: **Luma**, **Airbnb**, and **Booking**. This document outlines what has changed and what frontend developers need to update.

---

## API Changes Summary

### ✅ What Stayed the Same

1. **API Endpoints**: No changes to endpoint URLs
2. **Response Format**: Response structure remains the same
3. **Request Format**: Request format unchanged
4. **Authentication**: Same authentication requirements

### 🔄 What Changed

1. **New Data Sources**: Added `airbnb` and `booking` (Luma was already supported)
2. **Multiple Tasks per Source**: Each data source can now have multiple tasks
3. **Source Validation**: Updated to accept `amazon`, `luma`, `airbnb`, `booking`
4. **Error Messages**: Updated to include new data sources

---

## API Endpoints

### 1. Get Crawler Tasks

**Endpoint:** `GET /api/crawler-tasks`

**Query Parameters:**
- `source` (optional): Filter by data source - **Now accepts**: `amazon`, `luma`, `airbnb`, `booking`
- `status` (optional): Filter by status (`pending`, `running`, `done`, `error`)
- `search` (optional): Search by title or description
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 10, max: 100)

**Response Format (Unchanged):**
```json
{
  "status": "success",
  "data": {
    "tasks": [
      {
        "id": "task-uuid",
        "title": "Amazon Order History",
        "description": "Crawl your Amazon order history to earn rewards",
        "source": "amazon",
        "status": "pending",
        "recordCount": 0,
        "createdAt": "2025-12-15T10:00:00Z",
        "updatedAt": "2025-12-15T10:00:00Z",
        "dataUrl": null,
        "log": null,
        "tags": [
          { "id": "amazon", "name": "Amazon" },
          { "id": "orders", "name": "Orders" }
        ]
      },
      {
        "id": "task-uuid-2",
        "title": "Luma Events",
        "description": "Luma events history",
        "source": "luma",
        "status": "pending",
        "recordCount": 0,
        "createdAt": "2025-12-15T10:00:00Z",
        "updatedAt": "2025-12-15T10:00:00Z",
        "dataUrl": null,
        "log": null,
        "tags": [
          { "id": "luma", "name": "Luma" },
          { "id": "orders", "name": "Orders" }
        ]
      },
      {
        "id": "task-uuid-3",
        "title": "Airbnb Trips",
        "description": "Airbnb trips list",
        "source": "airbnb",
        "status": "pending",
        "recordCount": 0,
        "createdAt": "2025-12-15T10:00:00Z",
        "updatedAt": "2025-12-15T10:00:00Z",
        "dataUrl": null,
        "log": null,
        "tags": [
          { "id": "airbnb", "name": "Airbnb" },
          { "id": "orders", "name": "Orders" }
        ]
      },
      {
        "id": "task-uuid-4",
        "title": "Airbnb Past Trips",
        "description": "Airbnb past trips",
        "source": "airbnb",
        "status": "pending",
        "recordCount": 0,
        "createdAt": "2025-12-15T10:00:00Z",
        "updatedAt": "2025-12-15T10:00:00Z",
        "dataUrl": null,
        "log": null,
        "tags": [
          { "id": "airbnb", "name": "Airbnb" },
          { "id": "orders", "name": "Orders" }
        ]
      },
      {
        "id": "task-uuid-5",
        "title": "Booking Past Trips",
        "description": "Booking.com past trips list",
        "source": "booking",
        "status": "pending",
        "recordCount": 0,
        "createdAt": "2025-12-15T10:00:00Z",
        "updatedAt": "2025-12-15T10:00:00Z",
        "dataUrl": null,
        "log": null,
        "tags": [
          { "id": "booking", "name": "Booking" },
          { "id": "orders", "name": "Orders" }
        ]
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 5,
      "pages": 1
    }
  }
}
```

**Key Changes:**
- Now returns **multiple tasks per source** (e.g., Airbnb has 2 tasks, Booking has 3 tasks)
- New `source` values: `airbnb`, `booking`

---

### 2. Create Crawler Task

**Endpoint:** `POST /api/crawler-tasks`

**Request Body:**
```json
{
  "source": "airbnb"  // Now accepts: "amazon", "luma", "airbnb", "booking"
}
```

**Response (201 Created):**
```json
{
  "status": "success",
  "data": {
    "task": {
      "id": "task-uuid",
      "title": "Airbnb Trips",
      "description": "Airbnb trips list",
      "source": "airbnb",
      "status": "pending",
      "recordCount": 0,
      "createdAt": "2025-12-15T10:00:00Z",
      "updatedAt": "2025-12-15T10:00:00Z"
    }
  }
}
```

**Error Response (400 Bad Request):**
```json
{
  "status": "error",
  "message": "Invalid source. Must be \"amazon\", \"luma\", \"airbnb\", or \"booking\""
}
```

---

## Available Tasks by Source

### Amazon
- **1 task**: `Amazon Order History`

### Luma
- **1 task**: `Luma Events`

### Airbnb
- **2 tasks**:
  - `Airbnb Trips` - Airbnb trips list
  - `Airbnb Past Trips` - Airbnb past trips

### Booking
- **3 tasks**:
  - `Booking Past Trips` - Booking.com past trips list
  - `Booking Past Trip Bookings` - Booking.com bookings list for a past trip (trip detail)
  - `Booking Past Trip Booking Detail` - Booking.com archived booking detail (print view)

---

## Frontend Updates Required

### 1. Update Source Filter Options

**Before:**
```javascript
const sources = ['amazon', 'luma'];
```

**After:**
```javascript
const sources = ['amazon', 'luma', 'airbnb', 'booking'];
```

### 2. Update Source Validation

**Before:**
```javascript
if (!['amazon', 'luma'].includes(source)) {
  // Show error
}
```

**After:**
```javascript
if (!['amazon', 'luma', 'airbnb', 'booking'].includes(source)) {
  // Show error
}
```

### 3. Handle Multiple Tasks per Source

**Important:** Each data source can now return multiple tasks. Update your UI to handle this:

**Before (assuming one task per source):**
```javascript
const task = tasks.find(t => t.source === 'airbnb');
```

**After (handle multiple tasks):**
```javascript
const airbnbTasks = tasks.filter(t => t.source === 'airbnb');
// airbnbTasks will contain: "Airbnb Trips" and "Airbnb Past Trips"
```

### 4. Update Task Display Logic

If your frontend groups tasks by source, you may need to update the grouping logic:

```javascript
// Group tasks by source
const tasksBySource = tasks.reduce((acc, task) => {
  if (!acc[task.source]) {
    acc[task.source] = [];
  }
  acc[task.source].push(task);
  return acc;
}, {});

// Now each source can have multiple tasks
// tasksBySource.airbnb = [task1, task2]
// tasksBySource.booking = [task1, task2, task3]
```

### 5. Update Error Messages

If you display error messages to users, update them to include new sources:

**Before:**
```
"Invalid source. Must be 'amazon' or 'luma'"
```

**After:**
```
"Invalid source. Must be 'amazon', 'luma', 'airbnb', or 'booking'"
```

### 6. Update TypeScript Types (if using TypeScript)

**Before:**
```typescript
type CrawlerSource = 'amazon' | 'luma';
```

**After:**
```typescript
type CrawlerSource = 'amazon' | 'luma' | 'airbnb' | 'booking';
```

---

## Example: Updated Frontend Code

### Task List Component

```javascript
function CrawlerTaskList() {
  const [tasks, setTasks] = useState([]);
  const [selectedSource, setSelectedSource] = useState(null);
  
  // Updated sources
  const sources = ['amazon', 'luma', 'airbnb', 'booking'];
  
  useEffect(() => {
    fetchTasks();
  }, [selectedSource]);
  
  async function fetchTasks() {
    const params = new URLSearchParams();
    if (selectedSource) {
      params.append('source', selectedSource);
    }
    
    const response = await fetch(`/api/crawler-tasks?${params}`);
    const data = await response.json();
    
    // Now each source can have multiple tasks
    setTasks(data.data.tasks);
  }
  
  // Group tasks by source for display
  const tasksBySource = tasks.reduce((acc, task) => {
    if (!acc[task.source]) {
      acc[task.source] = [];
    }
    acc[task.source].push(task);
    return acc;
  }, {});
  
  return (
    <div>
      {/* Source filter */}
      <select onChange={(e) => setSelectedSource(e.target.value)}>
        <option value="">All Sources</option>
        {sources.map(source => (
          <option key={source} value={source}>{source}</option>
        ))}
      </select>
      
      {/* Display tasks grouped by source */}
      {Object.entries(tasksBySource).map(([source, sourceTasks]) => (
        <div key={source}>
          <h3>{source.toUpperCase()}</h3>
          {sourceTasks.map(task => (
            <div key={task.id}>
              <h4>{task.title}</h4>
              <p>{task.description}</p>
              <p>Status: {task.status}</p>
              <p>Records: {task.recordCount}</p>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
```

---

## Migration Checklist

- [ ] Update source filter options to include `airbnb` and `booking`
- [ ] Update source validation logic
- [ ] Update TypeScript types (if applicable)
- [ ] Update error messages
- [ ] Update UI to handle multiple tasks per source
- [ ] Test with all new data sources
- [ ] Update any hardcoded source checks

---

## Testing

### Test Cases

1. **Get all tasks:**
   ```bash
   GET /api/crawler-tasks
   ```
   Should return tasks from all sources (Amazon, Luma, Airbnb, Booking)

2. **Filter by Airbnb:**
   ```bash
   GET /api/crawler-tasks?source=airbnb
   ```
   Should return 2 tasks: "Airbnb Trips" and "Airbnb Past Trips"

3. **Filter by Booking:**
   ```bash
   GET /api/crawler-tasks?source=booking
   ```
   Should return 3 tasks: "Booking Past Trips", "Booking Past Trip Bookings", "Booking Past Trip Booking Detail"

4. **Create Airbnb task:**
   ```bash
   POST /api/crawler-tasks
   { "source": "airbnb" }
   ```
   Should create "Airbnb Trips" task (first task for the source)

5. **Invalid source:**
   ```bash
   POST /api/crawler-tasks
   { "source": "invalid" }
   ```
   Should return 400 error with updated message

---

## Backward Compatibility

✅ **Fully backward compatible** - Existing code will continue to work:
- Old source values (`amazon`, `luma`) still work
- Response format unchanged
- API endpoints unchanged

⚠️ **Minor breaking changes:**
- Error messages updated (but old messages still valid)
- New tasks will appear for existing users (when they first call the API)

---

## Support

For questions or issues, please contact the backend development team.

