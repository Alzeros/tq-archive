import test from 'node:test';
import assert from 'node:assert/strict';
import { isSignificantChange, significanceOf, significance, grade, levelFromBand, latencyByRegion, latencyFallback } from '../lib/thresholds.mjs';

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

// 热力图格子与卡片徽章必须同口径：同一份数据在详情页里出现两种颜色，
// 看久了就不会再信任任何一个。卡片的 3 档是权威，热力图的 5 个色阶
// 只能把每一档一分为二（浅/深），不能另立刻度。
test('热力图色阶与卡片档位严格同口径（穷举全部区域）', () => {
  const bands = { ...latencyByRegion, 未知: latencyFallback };
  const gradeOfLevel = level => (level <= 1 ? 'good' : level <= 3 ? 'fair' : 'bad');
  let checked = 0;
  for (const [code, band] of Object.entries(bands)) {
    for (let value = 1; value <= band.fair + 30; value += 1) {
      checked += 1;
      assert.equal(
        gradeOfLevel(levelFromBand(value, band)),
        grade(value, band),
        `${code} 区域 ${value}ms：卡片判 ${grade(value, band)}，色阶却是 l${levelFromBand(value, band)}`
      );
    }
  }
  assert.ok(checked > 9000, '要覆盖全部区域的全部整数延迟');
});

test('美国 172ms 这个具体案例：卡片说好，热力图也得是绿色系', () => {
  // 旧实现里 172ms 落在 l1 而卡片是 good，同一屏两种颜色；修复后两者一致
  const band = latencyByRegion.US;
  assert.equal(grade(172, band), 'good');
  assert.ok(levelFromBand(172, band) <= 1, '必须是绿色系（l0/l1），不能是黄色');
  assert.equal(grade(176, band), 'fair');
  assert.ok(levelFromBand(176, band) >= 2);
});

test('色阶边界不会越档：窄档区域（good 与 fair 只差 50）也不串色', () => {
  // 曾经想按 1.6×good 之类的比例推色阶，但 HK 的 fair 只有 150，一乘就冲到 fair 之外
  const band = latencyByRegion.HK;
  assert.equal(levelFromBand(band.good, band), 1, '正好等于 good 上限仍是绿色系');
  assert.equal(levelFromBand(band.good + 1, band), 2, '刚过 good 才是黄色系');
  assert.equal(levelFromBand(band.fair, band), 3);
  assert.equal(levelFromBand(band.fair + 1, band), 4);
});
