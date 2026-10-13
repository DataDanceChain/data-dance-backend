/**
 * Distilled titles drop the engagement and interface labels the App's Chinese UI shows next to a
 * post, and keep real titles that happen to contain 分享 or 收藏.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_LEVEL = 'error';
const { cleanTitle, themeTokens } = require('../../src/services/lifeContextDistill');

describe('cleanTitle strips UI labels', () => {
  const cases = [
    ['Sunset over the bay 赞评论转发分享', 'Sunset over the bay'],
    ['1,204 赞 36 评论 Sunset over the bay', 'Sunset over the bay'],
    ['评论 36 赞 1,204 Linen shirt', 'Linen shirt'],
    ['1.2万 评论 Morning coffee', 'Morning coffee'],
    ['京都红叶 赞 1.2万 评论 36', '京都红叶'],
    ['赞1,204评论36转发5 Kyoto', 'Kyoto'],
    ['留言 12 Coffee', 'Coffee'],
    ['内容更多选项 已静音 查看翻译 京都红叶', '京都红叶'],
    ['3小时前 Tokyo night walk', 'Tokyo night walk'],
    ['更多 10月12日 Lisbon trip', 'Lisbon trip'],
  ];
  for (const [raw, expected] of cases) {
    it(JSON.stringify(raw), () => assert.equal(cleanTitle(raw), expected));
  }
});

describe('cleanTitle keeps real titles that contain 分享 or 收藏', () => {
  for (const title of [
    '旅行分享：京都三日游',
    '分享3个护肤技巧',
    '分享收藏夹整理技巧',
    '收藏级黑胶唱片 Blue Note',
    '我的收藏 2024 精选',
    '2024 收藏级黑胶',
    'Top 10 分享会',
    '收藏夹整理',
    'Concert 2024 tour',
  ]) {
    it(JSON.stringify(title), () => assert.equal(cleanTitle(title), title));
  }
});

describe('themeTokens', () => {
  it('drops tokens made only of labels and counts', () => {
    assert.deepEqual(themeTokens('赞1204 评论36 转发 kyoto'), ['kyoto']);
    assert.deepEqual(themeTokens('1万赞 收藏 lisbon'), ['lisbon']);
  });

  it('keeps real tokens, plain numbers included', () => {
    assert.deepEqual(themeTokens('旅行分享 京都三日游'), ['旅行分享', '京都三日游']);
    assert.deepEqual(themeTokens('收藏级黑胶唱片 blue note'), ['收藏级黑胶唱片', 'blue', 'note']);
    assert.deepEqual(themeTokens('Concert 2024 tour'), ['concert', '2024', 'tour']);
  });
});
