# Christmas Features - Frontend API Integration Guide

## Overview

This document provides frontend developers with all the necessary API endpoints, request/response formats, and integration examples for the Christmas Welcome Bonus and Christmas Badge features.

---

## Base URL

```
Production: https://<YOUR_API_DOMAIN>
Development: http://localhost:3000
```

---

## Authentication

All endpoints require authentication. Include the JWT token in the Authorization header:

```
Authorization: Bearer <JWT_TOKEN>
```

---

## 1. Christmas Welcome Bonus

### 1.1 Get Welcome Bonus Status

**Endpoint:** `GET /api/users/christmas-welcome-bonus/status`

**Description:** Check if the user can claim the Christmas Welcome Bonus (5 points, one-time only during December 2025).

**Request:**
```javascript
const response = await fetch('/api/users/christmas-welcome-bonus/status', {
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
});
```

**Success Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "canClaim": true,
    "alreadyClaimed": false,
    "claimedAt": null,
    "pointsAwarded": null,
    "eventPeriod": {
      "start": "2025-12-01T00:00:00Z",
      "end": "2025-12-31T23:59:59Z"
    },
    "isEventActive": true
  }
}
```

**Response Fields:**
- `canClaim`: `boolean` - Whether user can claim the bonus
- `alreadyClaimed`: `boolean` - Whether user has already claimed
- `claimedAt`: `string | null` - Timestamp when claimed (if already claimed)
- `pointsAwarded`: `number | null` - Points awarded (if already claimed)
- `eventPeriod`: `object` - Event start and end dates
- `isEventActive`: `boolean` - Whether current time is within event period

**Example Usage:**
```javascript
async function checkWelcomeBonusStatus(token) {
  const response = await fetch('/api/users/christmas-welcome-bonus/status', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await response.json();
  return data.data;
}
```

---

### 1.2 Claim Welcome Bonus

**Endpoint:** `POST /api/users/christmas-welcome-bonus/claim`

**Description:** Claim the Christmas Welcome Bonus (5 points). Can only be claimed once per user during December 2025.

**Request:**
```javascript
const response = await fetch('/api/users/christmas-welcome-bonus/claim', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
});
```

**Success Response (200 OK):**
```json
{
  "status": "success",
  "message": "Christmas welcome bonus claimed successfully",
  "data": {
    "pointsAwarded": 5,
    "claimedAt": "2025-12-15T10:30:00Z",
    "totalPoints": 105
  }
}
```

**Error Responses:**

#### 400 - Already Claimed
```json
{
  "status": "error",
  "code": "ALREADY_CLAIMED",
  "message": "Christmas welcome bonus has already been claimed"
}
```

#### 400 - Not Eligible
```json
{
  "status": "error",
  "code": "NOT_ELIGIBLE",
  "message": "Christmas welcome bonus is not available at this time"
}
```

**Example Usage:**
```javascript
async function claimWelcomeBonus(token) {
  const response = await fetch('/api/users/christmas-welcome-bonus/claim', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await response.json();
  
  if (data.status === 'success') {
    console.log(`Claimed ${data.data.pointsAwarded} points!`);
    return data.data;
  } else {
    throw new Error(data.message);
  }
}
```

---

## 2. Christmas Badge Tasks

### 2.1 Verify X Follow

**Endpoint:** `POST /api/users/christmas-shopping/verify-x-follow`

**Description:** Mark the "Follow X (Twitter)" task as completed. This is a manual verification - user clicks the button after following the DDC X account.

**Request:**
```javascript
const response = await fetch('/api/users/christmas-shopping/verify-x-follow', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
});
```

**Success Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "verified": true,
    "alreadyCompleted": false,
    "verifiedAt": "2025-12-15T10:30:00Z",
    "taskId": "follow-x",
    "taskStatus": {
      "id": "follow-x",
      "title": "Follow X (Twitter)",
      "finalStatus": "COMPLETED",
      "progress": 1.0,
      "completedAt": "2025-12-15T10:30:00Z"
    },
    "allTasksStatus": {
      "upload-3-orders": {
        "id": "upload-3-orders",
        "title": "Upload 3+ December Orders",
        "finalStatus": "COMPLETED",
        "progress": 1.0,
        "doneCount": 3,
        "requiredCount": 3,
        "completedAt": "2025-12-14T08:00:00Z"
      },
      "follow-x": {
        "id": "follow-x",
        "title": "Follow X (Twitter)",
        "finalStatus": "COMPLETED",
        "progress": 1.0,
        "completedAt": "2025-12-15T10:30:00Z"
      },
      "join-telegram": {
        "id": "join-telegram",
        "title": "Join Telegram",
        "finalStatus": "IN_PROGRESS",
        "progress": 0.0,
        "doneCount": 0,
        "requiredCount": 1
      }
    },
    "allTasksCompleted": false
  }
}
```

**Response Fields:**
- `verified`: `boolean` - Whether verification succeeded
- `alreadyCompleted`: `boolean` - Whether task was already completed
- `verifiedAt`: `string` - Timestamp when verified
- `taskId`: `string` - Task identifier
- `taskStatus`: `object` - Status of the verified task
- `allTasksStatus`: `object` - Status of all Christmas shopping tasks
- `allTasksCompleted`: `boolean` - Whether all tasks are completed (triggers auto-claim badge)

**Example Usage:**
```javascript
async function verifyXFollow(token) {
  const response = await fetch('/api/users/christmas-shopping/verify-x-follow', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await response.json();
  
  if (data.status === 'success') {
    // Update UI with new task status
    updateTaskStatus(data.data.allTasksStatus);
    
    // Check if badge should be auto-claimed
    if (data.data.allTasksCompleted) {
      showBadgeClaimedNotification();
    }
    
    return data.data;
  }
}
```

---

### 2.2 Verify Telegram Join

**Endpoint:** `POST /api/users/christmas-shopping/verify-telegram-join`

**Description:** Mark the "Join Telegram" task as completed. This is a manual verification - user clicks the button after joining the Telegram group.

**Request:**
```javascript
const response = await fetch('/api/users/christmas-shopping/verify-telegram-join', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
});
```

**Success Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "verified": true,
    "alreadyCompleted": false,
    "verifiedAt": "2025-12-15T11:00:00Z",
    "taskId": "join-telegram",
    "taskStatus": {
      "id": "join-telegram",
      "title": "Join Telegram",
      "finalStatus": "COMPLETED",
      "progress": 1.0,
      "completedAt": "2025-12-15T11:00:00Z"
    },
    "allTasksStatus": {
      "upload-3-orders": {
        "id": "upload-3-orders",
        "title": "Upload 3+ December Orders",
        "finalStatus": "COMPLETED",
        "progress": 1.0,
        "doneCount": 3,
        "requiredCount": 3,
        "completedAt": "2025-12-14T08:00:00Z"
      },
      "follow-x": {
        "id": "follow-x",
        "title": "Follow X (Twitter)",
        "finalStatus": "COMPLETED",
        "progress": 1.0,
        "completedAt": "2025-12-15T10:30:00Z"
      },
      "join-telegram": {
        "id": "join-telegram",
        "title": "Join Telegram",
        "finalStatus": "COMPLETED",
        "progress": 1.0,
        "completedAt": "2025-12-15T11:00:00Z"
      }
    },
    "allTasksCompleted": true
  }
}
```

**Note:** Same format as Verify X Follow. If `allTasksCompleted` is `true`, the Christmas Badge will be automatically claimed.

---

## 3. Christmas Badge

### 3.1 Get Badges (with Task Status)

**Endpoint:** `GET /api/assets/badges`

**Description:** Get all badges. For the Christmas Badge, includes task status if not collected.

**Request:**
```javascript
const response = await fetch('/api/assets/badges', {
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
});
```

**Success Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "collected": [
      {
        "id": "other-badge-1",
        "name": "Other Badge",
        "description": "...",
        "image": "https://...",
        "acquiredAt": "2025-12-10T08:00:00Z"
      }
    ],
    "uncollected": [
      {
        "id": "christmas-badge-2025",
        "name": "Exclusive DDC Christmas Badge",
        "description": "Complete Christmas tasks to earn this exclusive badge and 5 Points",
        "image": "https://.../assets/badges/ddc-2025-christmas.png",
        "creator": {
          "id": "...",
          "name": "DataDance",
          "isOrganization": true
        },
        "taskStatus": {
          "canClaim": false,
          "tasksCompleted": 1,
          "totalTasks": 3,
          "missingTasks": [
            {
              "id": "follow-x",
              "title": "Follow X (Twitter)"
            },
            {
              "id": "join-telegram",
              "title": "Join Telegram"
            }
          ]
        }
      }
    ]
  }
}
```

**Response Fields:**
- `collected`: `array` - Badges the user has collected
- `uncollected`: `array` - Badges not yet collected
- `taskStatus` (for Christmas Badge only):
  - `canClaim`: `boolean` - Whether all tasks are completed
  - `tasksCompleted`: `number` - Number of completed tasks
  - `totalTasks`: `number` - Total number of tasks
  - `missingTasks`: `array` - List of incomplete tasks

**Example Usage:**
```javascript
async function getBadges(token) {
  const response = await fetch('/api/assets/badges', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await response.json();
  
  // Find Christmas Badge
  const christmasBadge = data.data.uncollected.find(
    b => b.id === 'christmas-badge-2025'
  );
  
  if (christmasBadge?.taskStatus) {
    console.log(`Tasks: ${christmasBadge.taskStatus.tasksCompleted}/${christmasBadge.taskStatus.totalTasks}`);
  }
  
  return data.data;
}
```

---

### 3.2 Collect Badge

**Endpoint:** `POST /api/assets/badges/:id/collect`

**Description:** Collect a badge. For the Christmas Badge, verifies all tasks are completed before allowing collection.

**Request:**
```javascript
const response = await fetch('/api/assets/badges/christmas-badge-2025/collect', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
});
```

**Success Response (200 OK):**
```json
{
  "status": "success",
  "message": "Badge collected successfully",
  "data": {
    "id": "christmas-badge-2025",
    "name": "Exclusive DDC Christmas Badge",
    "description": "Complete Christmas tasks to earn this exclusive badge and 5 Points",
    "image": "https://...",
    "creator": {
      "id": "...",
      "name": "DataDance",
      "isOrganization": true
    },
    "acquiredAt": "2025-12-15T10:30:00Z",
    "pointsAwarded": 5
  }
}
```

**Error Responses:**

#### 400 - Tasks Incomplete
```json
{
  "status": "error",
  "code": "TASKS_INCOMPLETE",
  "message": "Cannot claim Christmas Badge: tasks incomplete",
  "data": {
    "missingTasks": [
      {
        "id": "follow-x",
        "title": "Follow X (Twitter)"
      },
      {
        "id": "join-telegram",
        "title": "Join Telegram"
      }
    ]
  }
}
```

---

## 4. Complete Integration Example

```javascript
// React component example
import { useState, useEffect } from 'react';

function ChristmasFeatures({ token }) {
  const [welcomeBonus, setWelcomeBonus] = useState(null);
  const [badges, setBadges] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      // Load welcome bonus status
      const bonusRes = await fetch('/api/users/christmas-welcome-bonus/status', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const bonusData = await bonusRes.json();
      setWelcomeBonus(bonusData.data);

      // Load badges
      const badgesRes = await fetch('/api/assets/badges', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const badgesData = await badgesRes.json();
      setBadges(badgesData.data);
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  }

  async function claimWelcomeBonus() {
    try {
      const response = await fetch('/api/users/christmas-welcome-bonus/claim', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json();
      
      if (data.status === 'success') {
        alert(`Claimed ${data.data.pointsAwarded} points!`);
        loadData(); // Refresh
      } else {
        alert(data.message);
      }
    } catch (error) {
      console.error('Error claiming bonus:', error);
    }
  }

  async function verifyXFollow() {
    try {
      const response = await fetch('/api/users/christmas-shopping/verify-x-follow', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json();
      
      if (data.status === 'success') {
        // Update UI immediately
        loadData();
        
        if (data.data.allTasksCompleted) {
          alert('All tasks completed! Badge auto-claimed!');
        }
      }
    } catch (error) {
      console.error('Error verifying X follow:', error);
    }
  }

  async function verifyTelegramJoin() {
    try {
      const response = await fetch('/api/users/christmas-shopping/verify-telegram-join', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json();
      
      if (data.status === 'success') {
        loadData();
        
        if (data.data.allTasksCompleted) {
          alert('All tasks completed! Badge auto-claimed!');
        }
      }
    } catch (error) {
      console.error('Error verifying Telegram join:', error);
    }
  }

  if (loading) return <div>Loading...</div>;

  const christmasBadge = badges?.uncollected?.find(b => b.id === 'christmas-badge-2025');

  return (
    <div>
      {/* Welcome Bonus */}
      {welcomeBonus?.canClaim && (
        <div>
          <h3>Christmas Welcome Bonus</h3>
          <button onClick={claimWelcomeBonus}>Claim 5 Points</button>
        </div>
      )}

      {/* Christmas Badge Tasks */}
      {christmasBadge && (
        <div>
          <h3>Christmas Badge Tasks</h3>
          <p>
            Progress: {christmasBadge.taskStatus.tasksCompleted}/{christmasBadge.taskStatus.totalTasks}
          </p>
          
          {/* Follow X Task */}
          <div>
            <button onClick={() => window.open('https://x.com/ddc_official', '_blank')}>
              Follow X
            </button>
            <button onClick={verifyXFollow}>Verify</button>
          </div>

          {/* Join Telegram Task */}
          <div>
            <button onClick={() => window.open('https://t.me/ddc_official', '_blank')}>
              Join Telegram
            </button>
            <button onClick={verifyTelegramJoin}>Verify</button>
          </div>

          {/* Collect Badge Button */}
          {christmasBadge.taskStatus.canClaim && (
            <button onClick={async () => {
              const res = await fetch('/api/assets/badges/christmas-badge-2025/collect', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
              });
              const data = await res.json();
              if (data.status === 'success') {
                alert('Badge collected!');
                loadData();
              }
            }}>
              Collect Badge
            </button>
          )}
        </div>
      )}
    </div>
  );
}
```

---

## 5. Task Status Values

**Task Final Status:**
- `LOCKED` - Task is locked (prerequisite not met)
- `IN_PROGRESS` - Task is in progress
- `COMPLETED` - Task is completed (can be claimed)
- `CLAIMED` - Task has been claimed

**Progress:**
- `0.0` - Not started
- `0.0 - 0.99` - In progress
- `1.0` - Completed

---

## 6. Error Handling

All endpoints may return these common errors:

**401 - Unauthorized:**
```json
{
  "status": "error",
  "message": "Unauthorized"
}
```

**500 - Server Error:**
```json
{
  "status": "error",
  "message": "Server error"
}
```

Always handle errors gracefully:
```javascript
try {
  const response = await fetch('/api/...', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  
  const data = await response.json();
  
  if (data.status === 'error') {
    console.error('API error:', data.message);
    // Show user-friendly error message
    return;
  }
  
  // Handle success
} catch (error) {
  console.error('Request failed:', error);
  // Show user-friendly error message
}
```

---

## 7. Important Notes

1. **Auto-Claim Badge**: When all tasks are completed, the badge is automatically claimed. You don't need to call the collect endpoint.

2. **Idempotent Verification**: The verify endpoints can be called multiple times safely. They won't create duplicate records.

3. **Event Period**: Christmas features are only active during December 2025 (2025-12-01 to 2025-12-31).

4. **Task IDs**: 
   - `upload-3-orders` - Upload 3+ December Orders
   - `follow-x` - Follow X (Twitter)
   - `join-telegram` - Join Telegram

5. **Badge ID**: `christmas-badge-2025`

6. **Points**: 
   - Welcome Bonus: 5 points (one-time)
   - Badge Claim: 5 points (when all tasks completed)

---

## 8. Testing Checklist

- [ ] Welcome Bonus status API works
- [ ] Welcome Bonus claim API works
- [ ] Verify X Follow API works
- [ ] Verify Telegram Join API works
- [ ] Badges API returns Christmas Badge with task status
- [ ] Badge auto-claims when all tasks completed
- [ ] Badge collect API works (manual claim)
- [ ] Error handling works for all endpoints
- [ ] UI updates correctly after API calls
- [ ] Duplicate verification calls don't cause issues

---

## Support

For detailed API documentation, see:
- `docs/CHRISTMAS_BADGE_API.md` - Complete API reference
- `docs/CHRISTMAS_PRODUCTION_UPDATE.md` - Production deployment guide


