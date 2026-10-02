// 所有"主观"判定阈值集中在这里，改这一个文件即可，不要把阈值散落到代码中。
//
// 重要：延迟的绝对水平受机房地理位置支配 —— 美西机房回国的物理下限就在一百多毫秒，
// 而香港机房同样数字属于很差。因此这里的档位只做粗分，且刻意放宽；
// 真正的"异常"一律由 insight.mjs 用相对离群（中位数 / MAD）检出，不依赖这些数字。
export const thresholds = {
  // 延迟：越小越好
  latency: { unit: 'ms', good: 130, fair: 200, reverse: false },
  // 离散度（p90 − p50）：越小越好。与机房地理位置无关，比绝对延迟更能反映"线路是否均衡"
  spread: { unit: 'ms', good: 25, fair: 50, reverse: false },
  // 丢包 / 重传率：越小越好
  loss: { unit: '%', good: 0, fair: 2, reverse: false },
  // 速度：越大越好
  speed: { unit: 'Mbps', good: 300, fair: 100, reverse: true }
};

export const gradeLabels = { good: '好', fair: '一般', bad: '差' };

// 离群判定：与中位数的偏差超过 mad 倍数即视为离群。
// 3.5 是常用保守值，误报率低；速度类放宽到 5 倍比值，因为长尾本来就大。
export const outlier = { madFactor: 3.5, speedDivisor: 5, speedFloor: 50, lossDanger: 5 };
