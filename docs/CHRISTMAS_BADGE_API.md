# Christmas Badge API Documentation

## Overview

This document describes the API endpoints for the **Exclusive DDC Christmas Badge** feature. The Christmas Badge requires users to complete all Christmas Shopping tasks before it can be claimed.

---

## Endpoints

### 1. Get Badge List (with Christmas Badge Status)

**Endpoint:** `GET /api/assets/badges`

**Authentication:** Required (Bearer Token)

**Description:** Returns all badges (collected and uncollected) for the current user. For the Christmas Badge, includes task completion status.

**Request Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Response (200 OK):**

```json
{
  "status": "success",
  "data": {
    "collected": [
      {
        "id": "badge-uuid-1",
        "name": "Brand Badge",
        "description": "Brand collaboration badge",
        "image": "https://...",
        "creator": {
          "id": "creator-uuid",
          "name": "Brand Name",
          "isOrganization": true
        },
        "acquiredAt": "2024-12-15T10:30:00Z"
      }
    ],
    "uncollected": [
      {
        "id": "christmas-badge-2025",
        "name": "Exclusive DDC Christmas Badge",
        "description": "Complete Christmas tasks to earn this exclusive badge and 5 Points",
        "image": "https://...",
        "creator": {
          "id": "ddc-org-uuid",
          "name": "DataDance",
          "isOrganization": true
        },
        "taskStatus": {
          "canClaim": false,
          "tasksCompleted": 1,
          "totalTasks": 3,
          "missingTasks": [
            {
              "taskId": "upload-3-orders",
              "title": "Upload 3+ December Orders",
              "currentCount": 2,
              "requiredCount": 3,
              "progress": 0.67
            },
            {
              "taskId": "join-telegram",
              "title": "Join Telegram",
              "currentCount": 0,
              "requiredCount": 1,
              "progress": 0
            }
          ]
        }
      }
    ]
  }
}
```

**Response Fields:**

- `collected`: Array of badges the user has already collected
- `uncollected`: Array of badges the user hasn't collected yet
- `taskStatus` (only for Christmas Badge): Object containing task completion information
  - `canClaim`: `boolean` - Whether all tasks are completed and badge can be claimed
  - `tasksCompleted`: `number` - Number of completed tasks
  - `totalTasks`: `number` - Total number of Christmas Shopping tasks
  - `missingTasks`: `array` - Array of incomplete tasks
    - `taskId`: `string` - Task identifier
    - `title`: `string` - Task title
    - `currentCount`: `number` - Current progress count
    - `requiredCount`: `number` - Required count to complete
    - `progress`: `number` - Progress ratio (0-1)

**Notes:**
- `taskStatus` is only included for the Christmas Badge (`id: "christmas-badge-2025"`)
- If the Christmas Badge is already collected, `taskStatus` will not be included
- If all tasks are completed, `canClaim` will be `true` and `missingTasks` will be an empty array

---

### 2. Claim Badge (with Task Verification)

**Endpoint:** `POST /api/assets/badges/:id/collect`

**Authentication:** Required (Bearer Token)

**Description:** Claims a badge for the current user. For the Christmas Badge, verifies that all Christmas Shopping tasks are completed before allowing the claim.

**Request Headers:**
```
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

**URL Parameters:**
- `id`: Badge ID (e.g., `christmas-badge-2025`)

**Request Body:** None

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
      "id": "ddc-org-uuid",
      "name": "DataDance",
      "isOrganization": true
    },
    "acquiredAt": "2024-12-15T10:30:00Z",
    "pointsAwarded": 5
  }
}
```

**Error Responses:**

#### 400 - Tasks Incomplete

When trying to claim the Christmas Badge before completing all tasks:

```json
{
  "status": "error",
  "message": "Please complete all Christmas tasks before claiming the Christmas Badge",
  "code": "TASKS_INCOMPLETE",
  "data": {
    "missingTasks": [
      {
        "taskId": "upload-3-orders",
        "title": "Upload 3+ December Orders",
        "currentCount": 2,
        "requiredCount": 3,
        "progress": 0.67
      }
    ],
    "activityStatusUrl": "/user/awards?category=christmas-shopping"
  }
}
```

#### 400 - Already Collected

```json
{
  "status": "fail",
  "message": "You have already collected this badge"
}
```

#### 404 - Badge Not Found

```json
{
  "status": "fail",
  "message": "Badge not found"
}
```

#### 500 - Server Error

```json
{
  "status": "error",
  "message": "服务器错误",
  "error": "Error message (only in development)"
}
```

---

### 3. Verify X Follow

**Endpoint:** `POST /api/users/christmas-shopping/verify-x-follow`

**Authentication:** Required (Bearer Token)

**Description:** Verifies that the user has followed the DDC official X account. This is a manual verification - user clicks the button after following, and the system marks the task as completed.

**Request Headers:**
```
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

**Request Body:** None

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
- `alreadyCompleted`: `boolean` - Whether task was already completed before this call
- `verifiedAt`: `string` - Timestamp when task was verified/completed
- `taskId`: `string` - Task identifier
- `taskStatus`: `object` - Status of the verified task
- `allTasksStatus`: `object` - Status of all Christmas shopping tasks
- `allTasksCompleted`: `boolean` - Whether all tasks are completed (triggers auto-claim badge)

**Notes:**
- If task was already completed, `alreadyCompleted` will be `true` and `verifiedAt` will be the original completion time
- If all tasks are completed, the Christmas Badge will be automatically claimed
- This is an idempotent operation - calling it multiple times won't cause issues

---

### 4. Verify Telegram Join

**Endpoint:** `POST /api/users/christmas-shopping/verify-telegram-join`

**Authentication:** Required (Bearer Token)

**Description:** Verifies that the user has joined the Telegram group. This is a manual verification - user clicks the button after joining, and the system marks the task as completed.

**Request Headers:**
```
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

**Request Body:** None

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

**Response Fields:** (Same as Verify X Follow)

**Notes:**
- Same behavior as Verify X Follow
- If all tasks are completed after this verification, the Christmas Badge will be automatically claimed
- 5 Points will be automatically awarded with the badge

---

## Business Logic

### Christmas Badge Special Rules

1. **Task Verification Required:**
   - The Christmas Badge (`id: "christmas-badge-2025"`) requires all Christmas Shopping tasks to be completed before it can be claimed
   - Tasks are identified by the `awardId: "christmas-shopping"` in the task system
   - **December 2025 Order Filtering**: Only Amazon orders with `timestamp` in December 2025 (2025-12-01 to 2025-12-31) are counted

2. **Auto-Claim Feature:**
   - **Automatic Badge Claim**: When all Christmas Shopping tasks are completed (progress >= 1), the badge is **automatically claimed** without user action
   - Auto-claim happens when:
     - User completes the last task (via `claimTask`)
     - User views their tasks (via `getTasksByAward` for `christmas-shopping`)
   - Users do NOT need to manually claim the badge - it's awarded automatically

3. **Points Reward:**
   - Claiming the Christmas Badge awards **5 Points** to the user
   - Points are added to the user's total balance
   - A point record is created with `source: "BADGE_CLAIM"` and `sourceId: "christmas-badge-2025"`

4. **Task Status Check:**
   - Task status is checked in real-time when:
     - Getting the badge list (`GET /api/assets/badges`)
     - Attempting to claim the badge (`POST /api/assets/badges/:id/collect`)
     - Viewing Christmas shopping tasks (`GET /api/tasks/christmas-shopping`)

5. **Transaction Safety:**
   - Badge claim operations use database transactions to ensure data consistency
   - Prevents duplicate claims and ensures points are awarded correctly
   - Auto-claim operations are idempotent (safe to retry)

---

## Frontend Integration Guide

### 1. Display Badge List

```javascript
// Fetch badges
const response = await fetch('/api/assets/badges', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

const { data } = await response.json();

// Check for Christmas Badge
const christmasBadge = data.uncollected.find(
  badge => badge.id === 'christmas-badge-2025'
);

if (christmasBadge && christmasBadge.taskStatus) {
  const { canClaim, tasksCompleted, totalTasks, missingTasks } = 
    christmasBadge.taskStatus;
  
  // Display badge with task status
  if (!canClaim) {
    // Show lock icon or "Complete Tasks" indicator
    // Show progress: "1/3 tasks completed"
  }
}
```

### 2. Handle Badge Click

```javascript
async function handleBadgeClick(badge) {
  if (badge.id === 'christmas-badge-2025') {
    // Check task status
    if (badge.taskStatus && !badge.taskStatus.canClaim) {
      // Show task reminder modal
      showTaskReminderModal(badge.taskStatus.missingTasks);
      return;
    }
  }
  
  // Proceed with normal claim flow
  await claimBadge(badge.id);
}
```

### 3. Claim Badge

```javascript
async function claimBadge(badgeId) {
  try {
    const response = await fetch(`/api/assets/badges/${badgeId}/collect`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    const result = await response.json();
    
    if (result.status === 'error' && result.code === 'TASKS_INCOMPLETE') {
      // Show task reminder modal
      showTaskReminderModal(result.data.missingTasks);
      // Optionally navigate to tasks page
      // window.location.href = result.data.activityStatusUrl;
    } else if (result.status === 'success') {
      // Show success message
      if (result.data.pointsAwarded) {
        showSuccessMessage(
          `Badge claimed! You earned ${result.data.pointsAwarded} Points!`
        );
      }
      // Refresh badge list
      await refreshBadgeList();
    }
  } catch (error) {
    console.error('Error claiming badge:', error);
  }
}
```

### 4. Task Reminder Modal

```javascript
function showTaskReminderModal(missingTasks) {
  const taskList = missingTasks.map(task => 
    `• ${task.title} (${task.currentCount}/${task.requiredCount})`
  ).join('\n');
  
  const message = `Please complete all Christmas tasks before claiming this badge:\n\n${taskList}`;
  
  // Show modal with:
  // - Message
  // - List of incomplete tasks
  // - "Go to Tasks" button (links to /user/awards?category=christmas-shopping)
  // - "Cancel" button
}
```

---

## Error Handling

### Common Error Codes

- `TASKS_INCOMPLETE`: User tried to claim Christmas Badge before completing all tasks
- `ALREADY_COLLECTED`: User already has this badge
- `BADGE_NOT_FOUND`: Badge ID doesn't exist

### Error Response Format

All errors follow this format:

```json
{
  "status": "error" | "fail",
  "message": "Human-readable error message",
  "code": "ERROR_CODE",  // Optional
  "data": { }  // Optional, additional error data
}
```

---

## Testing Checklist

- [ ] Christmas Badge appears in uncollected section when tasks incomplete
- [ ] Badge shows `taskStatus` with `canClaim: false` when tasks incomplete
- [ ] `missingTasks` array contains correct incomplete tasks
- [ ] Badge shows `canClaim: true` when all tasks completed
- [ ] Claiming badge with incomplete tasks returns `TASKS_INCOMPLETE` error
- [ ] Claiming badge with completed tasks succeeds
- [ ] 5 Points are awarded when claiming Christmas Badge
- [ ] Badge appears in collected section after claim
- [ ] `taskStatus` is not included for collected Christmas Badge
- [ ] Other badges work normally without task verification
- [ ] Verify X Follow endpoint marks task as completed
- [ ] Verify Telegram Join endpoint marks task as completed
- [ ] Verification endpoints return updated task status
- [ ] Verification endpoints are idempotent (can be called multiple times)
- [ ] All tasks completed triggers automatic badge claim
- [ ] December orders are correctly filtered (only 2025-12-01 to 2025-12-31)

---

## Notes

1. **Christmas Badge ID:** The Christmas Badge must have the ID `christmas-badge-2025` in the database
2. **Award ID:** Christmas Shopping tasks must be associated with `awardId: "christmas-shopping"`
3. **Task IDs:** The following task IDs must exist in the database:
   - `upload-3-orders` - Upload 3+ December Orders task
   - `follow-x` - Follow X (Twitter) task
   - `join-telegram` - Join Telegram task
4. **Task Completion:** A task is considered completed when:
   - `finalStatus === 'COMPLETED'` or `claimed === true`
   - For manual verification tasks (follow-x, join-telegram): when `claimRecords` array has at least one entry
5. **December Order Filtering:** Only orders with `timestamp` between 2025-12-01 and 2025-12-31 are counted for Christmas tasks
6. **Manual Verification:** Follow X and Join Telegram tasks use manual verification - user clicks button after completing the action
7. **Auto-Claim:** The badge is automatically claimed when all tasks are completed - users don't need to manually claim it
8. **Points Source:** Points are recorded with `source: "BADGE_CLAIM"` and `sourceId: "christmas-badge-2025"`
9. **Transaction Safety:** All badge claim operations use database transactions for consistency
10. **Event Period:** The Christmas event runs from December 1, 2025 to December 31, 2025
11. **Idempotency:** Verification endpoints are idempotent - calling them multiple times won't cause duplicate records

---

## Contact

For questions or issues, please contact the backend development team.

