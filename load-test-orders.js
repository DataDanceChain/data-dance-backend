#!/usr/bin/env node

/**
 * Amazon Orders Data Upload Load Testing Script
 * 
 * This script performs stress testing on the Amazon order data upload API
 * to verify performance and stability under high load conditions after
 * increasing the express.json() body size limit to 10mb.
 * 
 * Usage:
 *   node load-test-orders.js
 * 
 * Configuration can be modified in the CONFIG section below.
 */

const axios = require('axios');

// ========================================
// CONFIGURATION
// ========================================
const CONFIG = {
  // Server configuration
  SERVER_URL: process.env.TEST_SERVER_URL || 'http://localhost:10000',
  
  // Authentication - Update with a valid JWT token for testing
  JWT_TOKEN: process.env.TEST_JWT_TOKEN || 'your-test-jwt-token-here',
  
  // Test scenarios configuration
  SINGLE_LARGE_REQUEST: {
    enabled: true,
    ordersPerRequest: 30900,  // Approx. 19.9MB payload
    requestCount: 1
  },
  
  HIGH_CONCURRENCY: {
    enabled: false, // Disabling for this specific test
    concurrentRequests: 30,
    ordersPerRequest: 75,
  },
  
  // Debug mode for troubleshooting
  DEBUG_MODE: {
    enabled: process.env.DEBUG_MODE === 'true',
    smallTestFirst: true,
    ordersPerRequest: 2
  },
  
  // Request timeout (in milliseconds)
  REQUEST_TIMEOUT: 60000, // Increased timeout for large payload
  
  // Delay between test scenarios (in milliseconds)
  SCENARIO_DELAY: 2000
};

// ========================================
// MOCK DATA GENERATION
// ========================================

/**
 * Sample product titles for realistic data size simulation
 */
const SAMPLE_PRODUCT_TITLES = [
  "Nature's Bounty Melatonin 5mg Dual Spectrum, 100% Drug Free Sleep Supplement, Quick Release and Extended Release, Promotes Relaxation and Sleep Health, 60 Bi-Layer Tablets",
  "Amazon Basics 64-Piece Kitchen Dinnerware Set, Service for 8 - Stoneware, Rustic White with Blue Rim",
  "Instant Pot Duo 7-in-1 Electric Pressure Cooker, Slow Cooker, Rice Cooker, Steamer, Sauté, Yogurt Maker, Warmer & Sterilizer, 6 Quart, 14 One-Touch Programs",
  "Apple AirPods Pro (2nd Generation) Wireless Earbuds with MagSafe Charging Case. Active Noise Cancelling, Transparency Mode, Spatial Audio, Touch Control",
  "SAMSUNG Galaxy S24 Ultra Cell Phone, 256GB AI Smartphone, Unlocked Android, 200MP Camera, S Pen, Long Battery Life, Fast Charging, US Version",
  "Stanley Quencher H2.0 Flowstate Tumbler | Vacuum Insulated Stainless Steel Travel Mug with Lid and Straw for Water, Iced Tea or Coffee",
  "Ninja Foodi Personal Blender for Shakes, Smoothies, Food Prep, and Frozen Blending with 18-Oz. BPA-Free Cup and Spout Lid",
  "Beats Studio3 Wireless Noise Cancelling Over-Ear Headphones - Apple W1 Headphone Chip, Class 1 Bluetooth, 22 Hours of Listening Time",
  "Fire TV Stick 4K Max streaming device, Wi-Fi 6, Alexa Voice Remote (includes TV controls), Free & Live TV",
  "Crest 3D White Professional Effects Whitestrips Teeth Whitening Kit, 22 Treatments"
];

/**
 * Generates a random Amazon order ID in correct format
 */
function generateOrderId() {
  // Amazon订单号格式：123-1234567-1234567
  const part1 = Math.floor(Math.random() * 900) + 100; // 3位数
  const part2 = Math.floor(Math.random() * 9000000) + 1000000; // 7位数
  const part3 = Math.floor(Math.random() * 9000000) + 1000000; // 7位数
  return `${part1}-${part2}-${part3}`;
}

/**
 * Generates a random date within the last 2 years
 */
function generateRandomDate() {
  const now = new Date();
  const twoYearsAgo = new Date(now.getFullYear() - 2, now.getMonth(), now.getDate());
  const randomTime = twoYearsAgo.getTime() + Math.random() * (now.getTime() - twoYearsAgo.getTime());
  return new Date(randomTime).toISOString().split('T')[0]; // Format: YYYY-MM-DD
}

/**
 * Generates a random product title
 */
function generateProductTitle() {
  return SAMPLE_PRODUCT_TITLES[Math.floor(Math.random() * SAMPLE_PRODUCT_TITLES.length)];
}

/**
 * Generates mock Amazon order data in the correct server format
 * @param {number} count - Number of orders to generate
 * @returns {Array} Array of order objects
 */
function generateMockOrders(count) {
  const orders = [];
  
  for (let i = 0; i < count; i++) {
    orders.push({
      source: 'amazon',
      type: 'order',
      payload: {
        orderid: generateOrderId(),
        title: generateProductTitle(),
        orderDate: generateRandomDate(),
        price: (Math.random() * 200 + 10).toFixed(2),
        quantity: Math.floor(Math.random() * 5) + 1,
        // Add some additional realistic data to increase payload size
        description: `Detailed product description for ${generateProductTitle()}. This item features high-quality materials and excellent customer reviews.`,
        category: ['Electronics', 'Home & Kitchen', 'Health & Personal Care', 'Books', 'Clothing'][Math.floor(Math.random() * 5)],
        brand: ['Amazon Basics', 'Generic Brand', 'Premium Brand', 'Popular Brand'][Math.floor(Math.random() * 4)],
        shippingAddress: {
          street: `${Math.floor(Math.random() * 9999) + 1} Main Street`,
          city: ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix'][Math.floor(Math.random() * 5)],
          state: 'CA',
          zipCode: `${Math.floor(Math.random() * 90000) + 10000}`
        }
      }
    });
  }
  
  return orders;
}

/**
 * Calculate the approximate size of orders data in bytes
 * @param {Array} orders - Array of order objects
 * @returns {number} Size in bytes
 */
function calculateDataSize(orders) {
  const jsonString = JSON.stringify({ data: orders });
  return Buffer.byteLength(jsonString, 'utf8');
}

/**
 * Calculate how many orders needed for target size
 * @param {number} targetSizeMB - Target size in MB
 * @returns {number} Number of orders needed
 */
function calculateOrdersForTargetSize(targetSizeMB) {
  const targetBytes = targetSizeMB * 1024 * 1024;
  const sampleOrders = generateMockOrders(10);
  const sampleSize = calculateDataSize(sampleOrders);
  const avgOrderSize = sampleSize / 10;
  return Math.ceil(targetBytes / avgOrderSize);
}

// ========================================
// PERFORMANCE METRICS
// ========================================

class PerformanceMetrics {
  constructor() {
    this.requests = [];
    this.startTime = null;
    this.endTime = null;
  }

  startTest() {
    this.startTime = Date.now();
    this.requests = [];
  }

  endTest() {
    this.endTime = Date.now();
  }

  addRequest(request) {
    this.requests.push(request);
  }

  generateReport() {
    const successful = this.requests.filter(r => r.success);
    const failed = this.requests.filter(r => !r.success);
    const responseTimes = successful.map(r => r.responseTime);
    
    const report = {
      testDuration: this.endTime - this.startTime,
      totalRequests: this.requests.length,
      successfulRequests: successful.length,
      failedRequests: failed.length,
      successRate: ((successful.length / this.requests.length) * 100).toFixed(2),
      averageResponseTime: responseTimes.length > 0 ? 
        (responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length).toFixed(0) : 'N/A',
      minResponseTime: responseTimes.length > 0 ? Math.min(...responseTimes) : 'N/A',
      maxResponseTime: responseTimes.length > 0 ? Math.max(...responseTimes) : 'N/A',
      errors: failed.map(r => ({ error: r.error, status: r.status }))
    };

    return report;
  }

  printReport(scenarioName, report) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 ${scenarioName} - Performance Report`);
    console.log(`${'='.repeat(60)}`);
    console.log(`⏱️  Test Duration: ${report.testDuration}ms`);
    console.log(`📨 Total Requests: ${report.totalRequests}`);
    console.log(`✅ Successful: ${report.successfulRequests}`);
    console.log(`❌ Failed: ${report.failedRequests}`);
    console.log(`📈 Success Rate: ${report.successRate}%`);
    console.log(`⚡ Avg Response Time: ${report.averageResponseTime}ms`);
    console.log(`🚀 Min Response Time: ${report.minResponseTime}ms`);
    console.log(`🐌 Max Response Time: ${report.maxResponseTime}ms`);
    
    if (report.errors.length > 0) {
      console.log(`\n❗ Error Details:`);
      report.errors.forEach((error, index) => {
        console.log(`   ${index + 1}. Status: ${error.status}, Error: ${error.error}`);
      });
    }
    console.log(`${'='.repeat(60)}\n`);
  }
}

// ========================================
// HTTP CLIENT
// ========================================

/**
 * Creates an HTTP client with configured headers
 */
function createHttpClient() {
  return axios.create({
    baseURL: CONFIG.SERVER_URL,
    timeout: CONFIG.REQUEST_TIMEOUT,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CONFIG.JWT_TOKEN}`
    }
  });
}

/**
 * Makes a single request to upload order data
 * @param {Array} orders - Array of order objects
 * @param {number} requestId - Request identifier for logging
 * @returns {Promise} Promise resolving to request result
 */
async function uploadOrders(orders, requestId) {
  const client = createHttpClient();
  const startTime = Date.now();
  
  try {
    console.log(`🚀 Request ${requestId}: Uploading ${orders.length} orders...`);
    
    const response = await client.post('/api/crawler/upload', { data: orders });
    const responseTime = Date.now() - startTime;
    
    console.log(`✅ Request ${requestId}: Success in ${responseTime}ms - ${response.data?.data?.uploadedCount || 'unknown'} orders uploaded`);
    
    return {
      requestId,
      success: true,
      responseTime,
      status: response.status,
      data: response.data,
      ordersCount: orders.length
    };
    
  } catch (error) {
    const responseTime = Date.now() - startTime;
    let status;
    let errorMessage;

    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      status = error.response.status;
      errorMessage = error.response.data?.message || JSON.stringify(error.response.data);
    } else if (error.request) {
      // The request was made but no response was received
      status = 'NO_RESPONSE';
      if (error.code === 'ECONNREFUSED') {
        errorMessage = `Connection refused. Is the server running at ${CONFIG.SERVER_URL}?`;
      } else if (error.code === 'ETIMEDOUT' || error.message.toLowerCase().includes('timeout')) {
        status = 'TIMEOUT';
        errorMessage = `Request timed out after ${CONFIG.REQUEST_TIMEOUT}ms. The server may be overloaded or down.`;
      } else {
        errorMessage = 'The server did not respond. Check network and server status.';
      }
    } else {
      // Something happened in setting up the request that triggered an Error
      status = 'REQUEST_SETUP_ERROR';
      errorMessage = error.message;
    }
    
    console.log(`❌ Request ${requestId}: Failed in ${responseTime}ms - Status: ${status}, Error: ${errorMessage}`);
    
    return {
      requestId,
      success: false,
      responseTime,
      status,
      error: errorMessage,
      ordersCount: orders.length
    };
  }
}

// ========================================
// TEST SCENARIOS
// ========================================

/**
 * Debug Test: Small request for troubleshooting
 */
async function testDebugMode() {
  if (!CONFIG.DEBUG_MODE.enabled) {
    return null;
  }

  console.log(`\n🔍 Starting Debug Mode Test`);
  console.log(`📦 Orders per request: ${CONFIG.DEBUG_MODE.ordersPerRequest}`);
  
  const metrics = new PerformanceMetrics();
  metrics.startTest();
  
  const orders = generateMockOrders(CONFIG.DEBUG_MODE.ordersPerRequest);
  console.log('Generated sample order:', JSON.stringify(orders[0], null, 2));
  
  const result = await uploadOrders(orders, 1);
  metrics.addRequest(result);
  
  metrics.endTest();
  const report = metrics.generateReport();
  metrics.printReport('Debug Mode', report);
  
  return report;
}

/**
 * Test Scenario 1: Single Large Request
 * Simulates a single user uploading a large batch of orders
 */
async function testSingleLargeRequest() {
  if (!CONFIG.SINGLE_LARGE_REQUEST.enabled) {
    console.log('⏭️  Skipping Single Large Request test (disabled)');
    return null;
  }

  console.log(`\n🎯 Starting Single Large Request Test`);
  console.log(`📦 Orders per request: ${CONFIG.SINGLE_LARGE_REQUEST.ordersPerRequest}`);
  
  const metrics = new PerformanceMetrics();
  metrics.startTest();
  
  const orders = generateMockOrders(CONFIG.SINGLE_LARGE_REQUEST.ordersPerRequest);
  const actualSize = calculateDataSize(orders);
  const actualSizeMB = (actualSize / (1024 * 1024)).toFixed(2);
  
  console.log(`📊 Payload size: ${actualSizeMB}MB (${actualSize} bytes)`);
  
  const result = await uploadOrders(orders, 1);
  metrics.addRequest(result);
  
  metrics.endTest();
  const report = metrics.generateReport();
  metrics.printReport('Single Large Request', report);
  
  return report;
}

/**
 * Test Scenario 2: High Concurrency
 * Simulates multiple users uploading data simultaneously
 */
async function testHighConcurrency() {
  if (!CONFIG.HIGH_CONCURRENCY.enabled) {
    console.log('⏭️  Skipping High Concurrency test (disabled)');
    return null;
  }

  console.log(`\n🎯 Starting High Concurrency Test`);
  console.log(`🔀 Concurrent requests: ${CONFIG.HIGH_CONCURRENCY.concurrentRequests}`);
  console.log(`📦 Orders per request: ${CONFIG.HIGH_CONCURRENCY.ordersPerRequest}`);
  
  const metrics = new PerformanceMetrics();
  metrics.startTest();
  
  // Create array of upload promises
  const uploadPromises = [];
  
  for (let i = 1; i <= CONFIG.HIGH_CONCURRENCY.concurrentRequests; i++) {
    const orders = generateMockOrders(CONFIG.HIGH_CONCURRENCY.ordersPerRequest);
    uploadPromises.push(uploadOrders(orders, i));
  }
  
  // Calculate total data size
  const sampleOrders = generateMockOrders(CONFIG.HIGH_CONCURRENCY.ordersPerRequest);
  const singleRequestSize = calculateDataSize(sampleOrders);
  const totalSize = singleRequestSize * CONFIG.HIGH_CONCURRENCY.concurrentRequests;
  const totalSizeMB = (totalSize / (1024 * 1024)).toFixed(2);
  
  console.log(`📊 Total data size across all requests: ${totalSizeMB}MB`);
  
  // Execute all requests concurrently
  const results = await Promise.all(uploadPromises);
  
  // Add all results to metrics
  results.forEach(result => metrics.addRequest(result));
  
  metrics.endTest();
  const report = metrics.generateReport();
  metrics.printReport('High Concurrency', report);
  
  return report;
}

// ========================================
// MAIN EXECUTION
// ========================================

/**
 * Validates configuration before running tests
 */
function validateConfig() {
  const errors = [];
  
  if (!CONFIG.JWT_TOKEN || CONFIG.JWT_TOKEN === 'your-test-jwt-token-here') {
    errors.push('JWT_TOKEN must be configured with a valid test token');
  }
  
  if (!CONFIG.SERVER_URL) {
    errors.push('SERVER_URL must be configured');
  }
  
  if (errors.length > 0) {
    console.error('❌ Configuration errors:');
    errors.forEach(error => console.error(`   - ${error}`));
    console.error('\n💡 Please update the CONFIG section in the script or set environment variables:');
    console.error('   - TEST_JWT_TOKEN: Valid JWT token for authentication');
    console.error('   - TEST_SERVER_URL: Target server URL (default: http://localhost:3001)');
    process.exit(1);
  }
}

/**
 * Delays execution for specified milliseconds
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Main function to orchestrate all tests
 */
async function main() {
  console.log('🧪 Amazon Orders Data Upload - Load Testing Script');
  console.log('==================================================');
  
  // Validate configuration
  validateConfig();
  
  console.log(`🎯 Target Server: ${CONFIG.SERVER_URL}`);
  console.log(`🔐 Using JWT Token: ${CONFIG.JWT_TOKEN.substring(0, 20)}...`);
  
  const allReports = [];
  
  try {
    // Debug Mode Test (if enabled)
    const debugReport = await testDebugMode();
    if (debugReport) {
      allReports.push({ scenario: 'Debug Mode', ...debugReport });
      // If debug mode fails, don't continue with stress tests
      if (debugReport.failedRequests > 0) {
        console.log('🛑 Debug mode failed, skipping stress tests. Fix the server issues first.');
        return;
      }
    }
    
    // Test Scenario 1: Single Large Request
    const singleRequestReport = await testSingleLargeRequest();
    if (singleRequestReport) {
      allReports.push({ scenario: 'Single Large Request', ...singleRequestReport });
    }
    
    // Delay between scenarios
    if (CONFIG.SINGLE_LARGE_REQUEST.enabled && CONFIG.HIGH_CONCURRENCY.enabled) {
      console.log(`⏳ Waiting ${CONFIG.SCENARIO_DELAY}ms before next scenario...`);
      await delay(CONFIG.SCENARIO_DELAY);
    }
    
    // Test Scenario 2: High Concurrency
    const concurrencyReport = await testHighConcurrency();
    if (concurrencyReport) {
      allReports.push({ scenario: 'High Concurrency', ...concurrencyReport });
    }
    
    // Final Summary
    console.log(`\n${'='.repeat(80)}`);
    console.log(`📋 FINAL SUMMARY`);
    console.log(`${'='.repeat(80)}`);
    
    allReports.forEach(report => {
      console.log(`\n${report.scenario}:`);
      console.log(`   Success Rate: ${report.successRate}%`);
      console.log(`   Avg Response Time: ${report.averageResponseTime}ms`);
      console.log(`   Total Requests: ${report.totalRequests}`);
    });
    
    const overallSuccess = allReports.every(report => report.failedRequests === 0);
    console.log(`\n${overallSuccess ? '🎉 All tests passed!' : '⚠️  Some tests had failures - check logs above'}`);
    
  } catch (error) {
    console.error('💥 Test execution failed:', error.message);
    process.exit(1);
  }
}

// Run the script if executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('💥 Unexpected error:', error);
    process.exit(1);
  });
}

module.exports = {
  generateMockOrders,
  uploadOrders,
  testSingleLargeRequest,
  testHighConcurrency,
  CONFIG
};