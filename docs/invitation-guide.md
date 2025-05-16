# Referral System Frontend Integration Guide

This document explains how to implement the referral system features in your frontend application.

## Usage Scenarios

### Scenario 1: Using a Referral Code

Users can use a referral code by calling the dedicated API endpoint:

```javascript
// Use a referral code
const response = await fetch('/api/referrals/use-code', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    code: 'REF-ABCD1234' // The referral code entered by the user
  })
});

const result = await response.json();
if (result.status === 'success') {
  // Referral code used successfully
  showSuccessMessage(result.message);
} else {
  // Handle various error cases
  switch(result.code) {
    case 'MISSING_CODE':
      showErrorMessage('Please provide a referral code');
      break;
    case 'ALREADY_REFERRED':
      showErrorMessage('You have already been referred and cannot use another code');
      break;
    case 'INVALID_CODE':
      showErrorMessage('Invalid referral code');
      break;
    case 'SELF_REFERRAL_NOT_ALLOWED':
      showErrorMessage('Cannot use your own referral code');
      break;
  }
}
```

### Scenario 2: Getting User's Own Referral Code

Users can get their own referral code to share with others:

```javascript
// Get current user's referral code
const response = await fetch('/api/users/referral-code', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

const { data } = await response.json();
// data.code is the user's referral code that can be displayed for sharing
```

### Scenario 3: Viewing Referral Status and Rewards

Users can check how many people they have referred and the rewards earned:

```javascript
// Get referral status
const response = await fetch('/api/referrals/status', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

const { data } = await response.json();
// Available information:
// - data.referralCount: Number of people referred
// - data.rewardsEarned: Points earned from referrals
// - data.referredBy: Who referred me (if any)
// - data.referees: List of users I referred

// For detailed overview including multi-level referrals
const overviewResponse = await fetch('/api/referrals/overview', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

const { data: overview } = await overviewResponse.json();
// Available information:
// - overview.referrals: Nested tree of referrals up to 4 levels deep
// - overview.levelCounts: Number of referrals at each level
// - overview.earnedByLevel: Points earned at each level
// - overview.totalReferralPoints: Total points earned
// - overview.unclaimReferralAwards: Points available to claim
// - overview.networkActivity: Overall network activity score
```

## Best Practices

1. **Error Handling**:
   - Implement error handling for all API calls
   - Display user-friendly error messages
   - Handle cases where referral codes have already been used
   - Prevent duplicate submissions

2. **User Experience**:
   - Provide clear access to the referral code input functionality
   - Implement a copy-to-clipboard feature for sharing referral codes
   - Display referral reward rules and commission rates clearly
   - Show real-time validation feedback for referral codes
   - Display multi-level referral tree in an intuitive way

3. **State Management**:
   - Update UI components when referral status changes
   - Cache referral status to reduce API calls
   - Preload referral information when appropriate

4. **Security**:
   - Include valid authentication tokens in all requests
   - Validate server responses and error codes
   - Implement rate limiting on the client side
   - Protect against CSRF and XSS attacks

## Implementation Tips

1. **When to Show Referral Features**:
   - Add an "Enter Referral Code" option in the user profile or settings
   - Display the user's referral code in a prominent but unobtrusive location
   - Show referral statistics and rewards in a dedicated dashboard
   - Present multi-level referral tree visualization when appropriate

2. **UI/UX Guidelines**:
   - Use clear CTAs for referral-related actions
   - Provide immediate feedback for successful/failed operations
   - Include tooltips or help text explaining the referral system and rewards
   - Make sharing referral codes intuitive and easy
   - Display commission rates and reward tiers clearly
   - Show a visual representation of the referral network

3. **Error Messages**:
   Make sure to handle and display all possible error cases:
   - `MISSING_CODE`: "Please provide a referral code"
   - `ALREADY_REFERRED`: "You have already been referred and cannot use another code"
   - `INVALID_CODE`: "Invalid referral code"
   - `SELF_REFERRAL_NOT_ALLOWED`: "Cannot use your own referral code"
   
4. **Reward Management**:
   - Show available rewards prominently
   - Display commission rates for different referral levels
   - Implement a clear reward claim process
   - Show reward history and pending rewards
   - Visualize progress towards reward tiers
