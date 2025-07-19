# Amazon Orders Data Upload - Load Testing Script

## Overview

This Node.js script performs stress testing on the Amazon order data upload API (`POST /api/crawler/upload`) to verify performance and stability under high load conditions. It was created to test the system after increasing the express.json() body size limit to 10mb.

## Features

- **Single Large Request Testing**: Simulates one user uploading a large batch of orders (default: 800 orders)
- **High Concurrency Testing**: Simulates multiple users uploading simultaneously (default: 30 concurrent requests with 75 orders each)
- **Realistic Data Generation**: Creates mock Amazon orders with realistic product titles and data sizes
- **Performance Metrics**: Tracks response times, success rates, and detailed error reporting
- **Configurable Parameters**: Easy to adjust test scenarios, server URLs, and authentication

## Usage

### Basic Usage

1. **Set up authentication**: You need a valid JWT token for testing
   ```bash
   export TEST_JWT_TOKEN="your-valid-jwt-token-here"
   ```

2. **Run the script**:
   ```bash
   node load-test-orders.js
   ```

### Configuration Options

The script can be configured by modifying the `CONFIG` object at the top of the file or by setting environment variables:

#### Environment Variables
- `TEST_JWT_TOKEN`: Valid JWT token for API authentication (required)
- `TEST_SERVER_URL`: Target server URL (default: `http://localhost:3001`)

#### Configuration Parameters
```javascript
const CONFIG = {
  // Server configuration
  SERVER_URL: 'http://localhost:3001',
  JWT_TOKEN: 'your-test-jwt-token-here',
  
  // Single large request test
  SINGLE_LARGE_REQUEST: {
    enabled: true,
    ordersPerRequest: 800,  // Number of orders in single request
    requestCount: 1
  },
  
  // High concurrency test
  HIGH_CONCURRENCY: {
    enabled: true,
    concurrentRequests: 30,  // Number of concurrent requests
    ordersPerRequest: 75,    // Orders per concurrent request
  },
  
  // Timeouts and delays
  REQUEST_TIMEOUT: 30000,   // Request timeout in milliseconds
  SCENARIO_DELAY: 2000      // Delay between test scenarios
};
```

## Test Scenarios

### 1. Single Large Request Test
- Uploads a large batch of orders in a single request
- Tests the system's ability to handle large request bodies
- Default: 800 orders per request

### 2. High Concurrency Test  
- Simulates multiple users uploading data simultaneously
- Tests the system's ability to handle concurrent load
- Default: 30 concurrent requests with 75 orders each

## Sample Output

```
🧪 Amazon Orders Data Upload - Load Testing Script
==================================================
🎯 Target Server: http://localhost:3001
🔐 Using JWT Token: eyJhbGciOiJIUzI1NiIs...

🎯 Starting Single Large Request Test
📦 Orders per request: 800
🚀 Request 1: Uploading 800 orders...
✅ Request 1: Success in 2341ms - 800 orders uploaded

============================================================
📊 Single Large Request - Performance Report
============================================================
⏱️  Test Duration: 2344ms
📨 Total Requests: 1
✅ Successful: 1
❌ Failed: 0
📈 Success Rate: 100.00%
⚡ Avg Response Time: 2341ms
🚀 Min Response Time: 2341ms
🐌 Max Response Time: 2341ms
============================================================
```

## Mock Data Structure

The script generates realistic Amazon order data with the following structure:

```javascript
{
  "source": "amazon",
  "orderId": "AMZ-TIMESTAMP-RANDOM",
  "productTitle": "Long product title with realistic length...",
  "orderDate": "2023-12-15",
  "price": "29.99",
  "quantity": 2
}
```

Product titles use realistic Amazon product names to simulate actual data sizes, such as:
- "Nature's Bounty Melatonin 5mg Dual Spectrum, 100% Drug Free Sleep Supplement..."
- "Amazon Basics 64-Piece Kitchen Dinnerware Set, Service for 8..."

## Performance Metrics

The script tracks and reports:
- **Test Duration**: Total time for the test scenario
- **Total/Successful/Failed Requests**: Request counts and success rate
- **Response Times**: Average, minimum, and maximum response times
- **Error Details**: Specific error messages and HTTP status codes

## Prerequisites

- Node.js with the following dependencies (already included in the project):
  - `axios` for HTTP requests
  - Standard Node.js modules

## Getting a Test JWT Token

To obtain a valid JWT token for testing:

1. Use an existing test user account
2. Login through the API: `POST /api/auth/login`
3. Extract the JWT token from the response
4. Use the token in the load testing script

Example login request:
```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "password": "password"}'
```

## Troubleshooting

### Common Issues

1. **JWT Token Required**: Make sure to set a valid JWT token
2. **Server Not Running**: Ensure the backend server is running on the specified URL
3. **Network Timeouts**: Increase `REQUEST_TIMEOUT` if requests are timing out
4. **Rate Limiting**: The API may have rate limits - adjust concurrency accordingly

### Error Messages

- `JWT_TOKEN must be configured`: Set the TEST_JWT_TOKEN environment variable
- `Status: 401`: Invalid or expired JWT token
- `Status: 429`: Rate limit exceeded
- `Status: TIMEOUT`: Request timeout, server may be overloaded

## Customization

You can customize the script for different testing scenarios:

- **Stress Testing**: Increase `concurrentRequests` and `ordersPerRequest`
- **Endurance Testing**: Add loops to run tests repeatedly
- **Specific Data Testing**: Modify `generateMockOrders()` to create specific data patterns
- **Different Endpoints**: Change the upload URL to test other endpoints

## Notes

- The script is designed to be non-destructive and uses mock data
- All generated order IDs are unique to avoid conflicts
- The script provides detailed logging for debugging and analysis
- Consider the impact on server resources when running high-load tests