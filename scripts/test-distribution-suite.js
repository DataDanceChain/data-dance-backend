/**
 * 分润系统测试套件主运行器
 * 统一管理和运行所有分润相关测试
 */

// 设置测试数据库连接
process.env.DATABASE_URL = 'postgresql://ddc:ddc@localhost:15432/ddc';

const { runDistributionServiceTests } = require('./test-distribution-service');
const { runTaskDistributionIntegrationTests } = require('./test-task-distribution-integration');
const { runEdgeCaseTests } = require('./test-distribution-edge-cases');
const { runPerformanceTestSuite } = require('./test-distribution-performance');
const { runDataConsistencyTests } = require('./test-distribution-data-consistency');

// 测试套件配置
const TEST_SUITES = {
  unit: {
    name: '单元测试',
    description: '测试分润服务的核心逻辑',
    runner: runDistributionServiceTests,
    essential: true
  },
  integration: {
    name: '集成测试',
    description: '测试真实任务完成流程中的分润功能',
    runner: runTaskDistributionIntegrationTests,
    essential: true
  },
  edge: {
    name: '边界条件测试',
    description: '测试各种边界情况和异常场景',
    runner: runEdgeCaseTests,
    essential: true
  },
  consistency: {
    name: '数据一致性测试',
    description: '验证分润系统的数据完整性和一致性',
    runner: runDataConsistencyTests,
    essential: true
  },
  performance: {
    name: '性能测试',
    description: '测试大量用户和高并发场景下的系统性能',
    runner: () => runPerformanceTestSuite('SMALL_SCALE'),
    essential: false
  }
};

// 工具函数
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function printHeader(title) {
  const line = '='.repeat(60);
  console.log(`\n${line}`);
  console.log(`🎯 ${title.toUpperCase()}`);
  console.log(line);
}

function printSummary(results) {
  printHeader('测试总结');
  
  let totalTests = 0;
  let passedTests = 0;
  let totalDuration = 0;
  
  Object.entries(results).forEach(([suite, result]) => {
    totalTests++;
    totalDuration += result.duration;
    
    const status = result.success ? '✅ PASS' : '❌ FAIL';
    const duration = formatDuration(result.duration);
    const essential = TEST_SUITES[suite].essential ? '[ESSENTIAL]' : '[OPTIONAL]';
    
    console.log(`${status} ${TEST_SUITES[suite].name} ${essential} - ${duration}`);
    
    if (result.success) {
      passedTests++;
    } else {
      console.log(`    错误: ${result.error}`);
    }
  });
  
  console.log(`\n统计信息:`);
  console.log(`  总测试数: ${totalTests}`);
  console.log(`  通过: ${passedTests}`);
  console.log(`  失败: ${totalTests - passedTests}`);
  console.log(`  总耗时: ${formatDuration(totalDuration)}`);
  console.log(`  成功率: ${((passedTests / totalTests) * 100).toFixed(1)}%`);
  
  // 检查必要测试是否全部通过
  const essentialTests = Object.entries(results).filter(([suite]) => TEST_SUITES[suite].essential);
  const passedEssential = essentialTests.filter(([_, result]) => result.success).length;
  
  if (passedEssential === essentialTests.length) {
    console.log(`\n🎉 所有必要测试通过！分润系统可以安全部署。`);
    return true;
  } else {
    console.log(`\n❌ 有 ${essentialTests.length - passedEssential} 个必要测试失败，请修复后再部署。`);
    return false;
  }
}

async function runTestSuite(suiteName, suiteConfig) {
  console.log(`\n📋 开始 ${suiteConfig.name}...`);
  console.log(`   ${suiteConfig.description}`);
  
  const startTime = Date.now();
  
  try {
    await suiteConfig.runner();
    const duration = Date.now() - startTime;
    
    console.log(`✅ ${suiteConfig.name} 完成 - ${formatDuration(duration)}`);
    
    return {
      success: true,
      duration,
      error: null
    };
    
  } catch (error) {
    const duration = Date.now() - startTime;
    
    console.error(`❌ ${suiteConfig.name} 失败 - ${formatDuration(duration)}`);
    console.error(`错误: ${error.message}`);
    
    return {
      success: false,
      duration,
      error: error.message
    };
  }
}

async function runFullTestSuite(options = {}) {
  const {
    includeOptional = false,
    specificSuites = null,
    stopOnFailure = false
  } = options;
  
  printHeader('分润系统测试套件');
  
  console.log('🚀 开始全面测试分润系统...\n');
  console.log('测试配置:');
  console.log(`  包含可选测试: ${includeOptional ? '是' : '否'}`);
  console.log(`  遇到失败停止: ${stopOnFailure ? '是' : '否'}`);
  console.log(`  数据库: ${process.env.DATABASE_URL?.split('@')[1] || '未知'}`);
  
  const results = {};
  const suitesToRun = specificSuites || Object.keys(TEST_SUITES);
  
  for (const suiteName of suitesToRun) {
    const suiteConfig = TEST_SUITES[suiteName];
    
    if (!suiteConfig) {
      console.log(`⚠️  未知测试套件: ${suiteName}`);
      continue;
    }
    
    // 跳过可选测试（除非明确要求）
    if (!suiteConfig.essential && !includeOptional && !specificSuites) {
      console.log(`⏭️  跳过可选测试: ${suiteConfig.name}`);
      continue;
    }
    
    const result = await runTestSuite(suiteName, suiteConfig);
    results[suiteName] = result;
    
    // 如果是必要测试失败且设置了停止选项
    if (!result.success && suiteConfig.essential && stopOnFailure) {
      console.log(`\n🛑 必要测试失败，停止后续测试`);
      break;
    }
  }
  
  // 打印总结
  const allPassed = printSummary(results);
  
  // 返回测试结果
  return {
    results,
    allPassed,
    totalSuites: Object.keys(results).length
  };
}

// CLI 参数解析
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    includeOptional: false,
    specificSuites: null,
    stopOnFailure: false,
    help: false
  };
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--include-optional':
      case '-o':
        options.includeOptional = true;
        break;
      case '--stop-on-failure':
      case '-s':
        options.stopOnFailure = true;
        break;
      case '--suites':
        if (i + 1 < args.length) {
          options.specificSuites = args[i + 1].split(',');
          i++;
        }
        break;
    }
  }
  
  return options;
}

function printUsage() {
  console.log(`
分润系统测试套件
===============

使用方法:
  node test-distribution-suite.js [选项]

选项:
  -h, --help              显示此帮助信息
  -o, --include-optional  包含可选测试（如性能测试）
  -s, --stop-on-failure   遇到必要测试失败时停止
  --suites <list>         只运行指定的测试套件（逗号分隔）

可用的测试套件:
  unit         - 单元测试 [必要]
  integration  - 集成测试 [必要]  
  edge         - 边界条件测试 [必要]
  consistency  - 数据一致性测试 [必要]
  performance  - 性能测试 [可选]

示例:
  # 运行所有必要测试
  node test-distribution-suite.js
  
  # 运行所有测试（包含性能测试）
  node test-distribution-suite.js --include-optional
  
  # 只运行单元测试和集成测试
  node test-distribution-suite.js --suites unit,integration
  
  # 运行所有测试，遇到失败停止
  node test-distribution-suite.js --include-optional --stop-on-failure

注意事项:
  - 确保测试数据库正在运行 (localhost:15432)
  - 确保API服务器正在运行 (localhost:10000) - 仅集成测试需要
  - 测试会自动清理产生的测试数据
  - 性能测试可能需要较长时间
`);
}

// 主函数
async function main() {
  const options = parseArgs();
  
  if (options.help) {
    printUsage();
    process.exit(0);
  }
  
  try {
    const { allPassed } = await runFullTestSuite(options);
    
    if (allPassed) {
      console.log('\n🎉 所有测试通过！系统可以安全部署。');
      process.exit(0);
    } else {
      console.log('\n❌ 部分测试失败，请查看上述错误信息。');
      process.exit(1);
    }
    
  } catch (error) {
    console.error('\n💥 测试套件运行时发生严重错误:');
    console.error(error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// 导出模块供其他脚本使用
module.exports = {
  runFullTestSuite,
  runTestSuite,
  TEST_SUITES
};

// 当作为主模块运行时执行测试
if (require.main === module) {
  main();
}