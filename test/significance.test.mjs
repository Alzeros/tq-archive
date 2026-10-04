import test from 'node:test';
import assert from 'node:assert/strict';
import { isSignificantChange, significanceOf, significance } from '../lib/thresholds.mjs';

// 对比视图的信噪比问题：同机两次测试之间 ±1~16ms 的抖动会铺出几百行，
// 把"吉林联通丢包 +78%"这种真正的信号埋掉。这里定的是"小于它就算噪声"的下限。

test('延迟：10ms 以内的抖动不算显著，达到门槛才算', () => {
  assert.equal(isSignificantChange('latency', 1, 58, 59), false);
  assert.equal(isSignificantChange('latency', -6, 61, 55), false, '方向不影响判定');
  assert.equal(isSignificantChange('latency', 9.9, 60, 69.9), false);
  assert.equal(isSignificantChange('latency', 10, 60, 70), true);
  assert.equal(isSignificantChange('latency', -16, 61, 45), true);
});

test('丢包/重传：0% → 1% 是质变，门槛按 0.5 判', () => {
  assert.equal(isSignificantChange('loss', 0.4, 0, 0.4), false);
  assert.equal(isSignificantChange('loss', 1, 0, 1), true, '从无到有必须报出来');
  assert.equal(isSignificantChange('loss', 78, 0, 78), true);
  assert.equal(isSignificantChange('retrans', 0.5, 2, 2.5), true);
  assert.equal(isSignificantChange('returnRetrans', 0.2, 3, 3.2), false);
});

test('速度：相对幅度与绝对下限都要看', () => {
  // 腰斩是信号
  assert.equal(isSignificantChange('returnSpeed', -400, 800, 400), true);
  // 低速机上 25Mbps 的波动：相对幅度超过 5%，但绝对量也够大
  assert.equal(isSignificantChange('returnSpeed', -25, 120, 95), true);
  // 高速机上的小波动：绝对量大但相对幅度不足 5%
  assert.equal(isSignificantChange('returnSpeed', -30, 1500, 1470), false);
  // 低速机上的小绝对波动：两个条件都不满足
  assert.equal(isSignificantChange('returnSpeed', -2, 30, 28), false);
  // 对称性：上调与下调用同一套判定
  assert.equal(isSignificantChange('returnSpeed', 30, 1470, 1500), false);
  assert.equal(isSignificantChange('downloadSpeed', -500, 1000, 500), true);
});

test('延迟族与测速族按名字归类，不会互相串门', () => {
  assert.equal(significanceOf('latency'), significance.latency);
  assert.equal(significanceOf('returnLatency'), significance.latency);
  assert.equal(significanceOf('downloadLatency'), significance.latency);
  // loss 是 retrans 的子串，先判 retrans 才不会把重传按丢包门槛算
  assert.equal(significanceOf('retrans'), significance.retrans);
  assert.equal(significanceOf('downloadRetransRate'), significance.retrans);
  assert.equal(significanceOf('loss'), significance.loss);
  assert.equal(significanceOf('returnSpeed'), significance.returnSpeed);
  assert.equal(significanceOf('outboundSpeed'), significance.returnSpeed);
});

test('未列出的指标（路由、可达、域名这类文本）按变化即显著处理', () => {
  assert.equal(significanceOf('route'), null);
  assert.equal(isSignificantChange('route', 1, 1, 2), true);
  assert.equal(isSignificantChange('reachable', 1, 0, 1), true);
});

test('零变化与非法数值一律不算显著', () => {
  for (const metric of ['latency', 'loss', 'returnSpeed', 'route']) {
    assert.equal(isSignificantChange(metric, 0, 100, 100), false, `${metric} 零变化`);
  }
  assert.equal(isSignificantChange('latency', NaN, 1, 2), false);
  assert.equal(isSignificantChange('latency', Infinity, 1, 2), false, 'Infinity 不是有效变化量');
});
