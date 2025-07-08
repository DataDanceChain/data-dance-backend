#!/usr/bin/env node

/**
 * Demo版本 - Amazon Orders Data Upload Load Testing Script
 * 
 * 这个版本使用模拟响应来演示脚本在正常工作时的完整功能和输出
 */

const axios = require('axios');

const CONFIG = {
  SERVER_URL: 'http://localhost:10000',
  JWT_TOKEN: 'demo-token',
  SINGLE_LARGE_REQUEST: {
    enabled: true,
    ordersPerRequest: 800,
    requestCount: 1
  },
  HIGH_CONCURRENCY: {
    enabled: true,
    concurrentRequests: 30,
    ordersPerRequest: 75,
  },
  REQUEST_TIMEOUT: 30000,
  SCENARIO_DELAY: 2000,
  DEMO_MODE: true  // 启用演示模式
};

// Performance Metrics class (same as original)
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

// Mock data generation functions (same as original)
const SAMPLE_PRODUCT_TITLES = [
  "Nature's Bounty Melatonin 5mg Dual Spectrum, 100% Drug Free Sleep Supplement, Quick Release and Extended Release, Promotes Relaxation and Sleep Health, 60 Bi-Layer Tablets",
  "Amazon Basics 64-Piece Kitchen Dinnerware Set, Service for 8 - Stoneware, Rustic White with Blue Rim",
  "Instant Pot Duo 7-in-1 Electric Pressure Cooker, Slow Cooker, Rice Cooker, Steamer, Sauté, Yogurt Maker, Warmer & Sterilizer, 6 Quart, 14 One-Touch Programs"
];

function generateOrderId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `AMZ-${timestamp}-${random}`.toUpperCase();
}

function generateRandomDate() {
  const now = new Date();
  const twoYearsAgo = new Date(now.getFullYear() - 2, now.getMonth(), now.getDate());
  const randomTime = twoYearsAgo.getTime() + Math.random() * (now.getTime() - twoYearsAgo.getTime());
  return new Date(randomTime).toISOString().split('T')[0];
}

function generateProductTitle() {
  return SAMPLE_PRODUCT_TITLES[Math.floor(Math.random() * SAMPLE_PRODUCT_TITLES.length)];
}

function generateMockOrders(count) {
  const orders = [];
  for (let i = 0; i < count; i++) {
    orders.push({
      source: 'amazon',
      orderId: generateOrderId(),
      productTitle: generateProductTitle(),
      orderDate: generateRandomDate(),
      price: (Math.random() * 200 + 10).toFixed(2),
      quantity: Math.floor(Math.random() * 5) + 1
    });
  }
  return orders;
}

// 模拟请求函数 - 返回成功的响应
async function uploadOrders(orders, requestId) {
  const startTime = Date.now();
  
  console.log(`🚀 Request ${requestId}: Uploading ${orders.length} orders...`);
  
  // 模拟网络延迟
  const simulatedDelay = Math.random() * 2000 + 500; // 500-2500ms
  await new Promise(resolve => setTimeout(resolve, simulatedDelay));
  
  const responseTime = Date.now() - startTime;
  
  // 模拟偶尔的失败（5%概率）
  if (Math.random() < 0.05) {
    console.log(`❌ Request ${requestId}: Failed in ${responseTime}ms - Status: 429, Error: Rate limit exceeded`);
    return {
      requestId,
      success: false,
      responseTime,
      status: 429,
      error: 'Rate limit exceeded',
      ordersCount: orders.length
    };
  }
  
  // 模拟成功响应
  console.log(`✅ Request ${requestId}: Success in ${responseTime}ms - ${orders.length} orders uploaded`);
  
  return {
    requestId,
    success: true,
    responseTime,
    status: 200,
    data: {
      uploadedCount: orders.length,
      pointsEarned: orders.length * 10,
      duplicatesCount: 0,
      message: 'Data uploaded successfully'
    },
    ordersCount: orders.length
  };
}

// Test scenarios (same structure as original)
async function testSingleLargeRequest() {
  console.log(`\n🎯 Starting Single Large Request Test`);
  console.log(`📦 Orders per request: ${CONFIG.SINGLE_LARGE_REQUEST.ordersPerRequest}`);
  
  const metrics = new PerformanceMetrics();
  metrics.startTest();
  
  const orders = generateMockOrders(CONFIG.SINGLE_LARGE_REQUEST.ordersPerRequest);
  const result = await uploadOrders(orders, 1);
  metrics.addRequest(result);
  
  metrics.endTest();
  const report = metrics.generateReport();
  metrics.printReport('Single Large Request', report);
  
  return report;
}

async function testHighConcurrency() {
  console.log(`\n🎯 Starting High Concurrency Test`);
  console.log(`🔀 Concurrent requests: ${CONFIG.HIGH_CONCURRENCY.concurrentRequests}`);
  console.log(`📦 Orders per request: ${CONFIG.HIGH_CONCURRENCY.ordersPerRequest}`);
  
  const metrics = new PerformanceMetrics();
  metrics.startTest();
  
  const uploadPromises = [];
  
  for (let i = 1; i <= CONFIG.HIGH_CONCURRENCY.concurrentRequests; i++) {
    const orders = generateMockOrders(CONFIG.HIGH_CONCURRENCY.ordersPerRequest);
    uploadPromises.push(uploadOrders(orders, i));
  }
  
  const results = await Promise.all(uploadPromises);
  results.forEach(result => metrics.addRequest(result));
  
  metrics.endTest();
  const report = metrics.generateReport();
  metrics.printReport('High Concurrency', report);
  
  return report;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('🧪 Amazon Orders Data Upload - Load Testing Script (DEMO)');
  console.log('========================================================');
  console.log('⚠️  Running in demo mode with simulated responses');
  
  const allReports = [];
  
  try {
    const singleRequestReport = await testSingleLargeRequest();
    if (singleRequestReport) {
      allReports.push({ scenario: 'Single Large Request', ...singleRequestReport });
    }
    
    console.log(`⏳ Waiting ${CONFIG.SCENARIO_DELAY}ms before next scenario...`);
    await delay(CONFIG.SCENARIO_DELAY);
    
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
    
    const overallSuccess = allReports.every(report => parseFloat(report.successRate) > 95);
    console.log(`\n${overallSuccess ? '🎉 All tests passed successfully!' : '⚠️  Some tests had issues - check logs above'}`);
    
  } catch (error) {
    console.error('💥 Test execution failed:', error.message);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('💥 Unexpected error:', error);
  });
}