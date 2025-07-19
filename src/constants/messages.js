// Standardized English messages for the Data Dance backend

const CRAWLER_MESSAGES = {
  // Validation errors
  INVALID_SOURCE: 'Data source must be amazon or luma',
  INVALID_TYPE: 'Data type cannot be empty',
  INVALID_PAYLOAD: 'Payload data must be a valid object',
  AMAZON_ORDERID_REQUIRED: 'Amazon data must include orderid field',
  AMAZON_ORDER_FORMAT_WARNING: 'Amazon order ID format should be: 123-1234567-1234567',
  
  // Suggestions
  SUGGEST_TITLE: 'Product title is recommended',
  SUGGEST_PRICE: 'Price information is recommended',
  SUGGEST_CURRENCY: 'Currency code (e.g., USD, EUR) is recommended',
  SUGGEST_LUMA_ID: 'Luma event ID or task ID is recommended for better data quality',
  SUGGEST_SOURCE_URL: 'Source URL is recommended for traceability',
  
  // Quality warnings
  LOW_QUALITY_SCORE: (score) => `Data quality score is low (${score}/100), please improve data format`,
  
  // Upload status
  UPLOAD_START: (userId, count) => `[CrawlerService] Starting to process ${count} items for user ${userId}`,
  DEDUP_RESULT: (valid, duplicate) => `[CrawlerService] Deduplication result: ${valid} valid, ${duplicate} duplicate`,
  UPLOAD_SUCCESS: (count, points) => `[CrawlerService] Successfully uploaded ${count} items, earned ${points} points`,
  POINTS_AWARDED: (userId, points) => `[CrawlerService] Awarded ${points} points to user ${userId}`,
  
  // Limit errors
  DAILY_LIMIT_EXCEEDED: (current, limit, attempted) => `Daily upload limit exceeded. Uploaded today: ${current}/${limit}, attempted: ${attempted}`,
  MONTHLY_LIMIT_EXCEEDED: (current, limit, attempted) => `Monthly upload limit exceeded. Uploaded this month: ${current}/${limit}, attempted: ${attempted}`,
  
  // Response messages
  INVALID_DATA_FORMAT: 'Data must be a non-empty array',
  ALL_DUPLICATES: 'All data items are duplicates',
  NO_VALID_DATA: 'No valid data to upload',
  SUCCESS_MESSAGE: (count, points) => `Successfully uploaded ${count} items, earned ${points} points`,
  
  // Error messages
  UPLOAD_FAILED: '[CrawlerService] Data upload failed:',
  TASK_NOT_FOUND: 'Task not found for user',
  UNAUTHORIZED_ACCESS: 'Unauthorized access to task data'
};

const DISTRIBUTION_MESSAGES = {
  // Processing logs
  START_DISTRIBUTION: (userId, amount, levels) => `[Distribution] Starting upline reward distribution for user ${userId}, base amount: ${amount}, levels: ${levels}`,
  PROCESS_LEVEL: (level, referrerId, percentage, reward) => `[Distribution] Processing level ${level}: referrer ${referrerId}, percentage: ${percentage}%, reward: ${reward}`,
  AWARD_SUCCESS: (referrerId, reward, level) => `[Distribution] Successfully awarded ${reward} points to ${referrerId} (level ${level})`,
  DISTRIBUTION_COMPLETE: (totalDistributed, levels) => `[Distribution] Completed distribution: ${totalDistributed} points distributed across ${levels} levels`,
  
  // Validation errors
  INVALID_USER: 'Invalid user ID',
  INVALID_AMOUNT: 'Base reward amount must be positive',
  INVALID_PERCENTAGES: 'Invalid upline percentages configuration',
  
  // Error logs
  NO_REFERRER: (userId) => `[Distribution] User ${userId} has no referrer, stopping distribution`,
  DISTRIBUTION_ERROR: (error) => `[Distribution] Error during upline distribution: ${error}`,
  TRANSACTION_REQUIRED: 'Prisma transaction is required for distribution'
};

const TASK_MESSAGES = {
  // Chinese comments that need translation
  VALIDATION_COMMENT: 'Validate business completion conditions (progress >= 1)',
  DISTRIBUTION_COMMENT: 'Process upline reward distribution (all tasks enjoy distribution)',
  DISTRIBUTION_SUCCESS: (userId, taskId, baseReward, result) => `Upline distribution completed successfully`,
  DISTRIBUTION_FAILED: (userId, taskId, baseReward, error) => `Upline distribution failed`,
  DISTRIBUTION_NOTE: 'Distribution failure does not affect main task completion, but error needs to be logged'
};

const REFERRAL_MESSAGES = {
  // System messages
  REFERRAL_CREATED: (inviterId, inviteeId) => `[Referral] Created referral relationship: inviter ${inviterId}, invitee ${inviteeId}`,
  DIRECT_REWARD_AWARDED: (inviterId, points) => `[Referral] Awarded ${points} points to inviter ${inviterId} for direct referral`,
  MULTILEVEL_PROGRESS: (userId, level) => `[Referral] Recorded level ${level} referral progress for user ${userId}`,
  
  // Error messages
  ALREADY_REFERRED: 'User has already been referred',
  INVALID_REFERRAL_CODE: 'Invalid or expired referral code',
  SELF_REFERRAL: 'Cannot use your own referral code',
  REFERRER_NOT_FOUND: 'Referrer not found'
};

module.exports = {
  CRAWLER_MESSAGES,
  DISTRIBUTION_MESSAGES,
  TASK_MESSAGES,
  REFERRAL_MESSAGES
};