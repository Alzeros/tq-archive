// 所有"主观"判定阈值集中在这里，改这一个文件即可，不要把阈值散落到代码中。
//
// 延迟的绝对水平由「机房到中国的物理距离」支配：香港 25ms 和法兰克福 175ms 都是各自
// 区域的正常水平。用同一个绝对阈值去判两者，等于把"离得远"误判成"线路差"。
// 因此延迟按机房区域分档，档位由节点的 region 字段（探针元数据）选出。

// 延迟基准：[好上限, 一般上限]，单位 ms。超过「一般上限」即为差。
// 数值含义是"该区域回国的合理范围"，不是"全球统一的好坏线"。
export const latencyByRegion = {
  CN: { label: '中国大陆', good: 35, fair: 80 },
  HK: { label: '中国香港', good: 55, fair: 100 },
  MO: { label: '中国澳门', good: 55, fair: 100 },
  TW: { label: '中国台湾', good: 75, fair: 120 },
  JP: { label: '日本', good: 85, fair: 135 },
  KR: { label: '韩国', good: 85, fair: 135 },
  SG: { label: '新加坡', good: 95, fair: 145 },
  MY: { label: '马来西亚', good: 100, fair: 150 },
  TH: { label: '泰国', good: 100, fair: 150 },
  VN: { label: '越南', good: 95, fair: 145 },
  PH: { label: '菲律宾', good: 100, fair: 155 },
  ID: { label: '印度尼西亚', good: 105, fair: 160 },
  IN: { label: '印度', good: 130, fair: 190 },
  AE: { label: '阿联酋', good: 150, fair: 210 },
  TR: { label: '土耳其', good: 170, fair: 230 },
  RU: { label: '俄罗斯', good: 140, fair: 200 },
  AU: { label: '澳大利亚', good: 150, fair: 215 },
  NZ: { label: '新西兰', good: 165, fair: 225 },
  // 美西与德国的实测分位几乎一致（法兰克福 p50=172 / 洛杉矶 p50=175，min 均约 125），
  // 说明两地到中国的实际路径长度相当，因此共用同一档，而不是凭地理直觉给德国更宽的线。
  US: { label: '美国', good: 175, fair: 225 },
  CA: { label: '加拿大', good: 180, fair: 230 },
  MX: { label: '墨西哥', good: 195, fair: 255 },
  BR: { label: '巴西', good: 270, fair: 340 },
  GB: { label: '英国', good: 185, fair: 245 },
  DE: { label: '德国', good: 175, fair: 225 },
  NL: { label: '荷兰', good: 180, fair: 235 },
  FR: { label: '法国', good: 190, fair: 250 },
  ES: { label: '西班牙', good: 195, fair: 255 },
  IT: { label: '意大利', good: 190, fair: 250 },
  SE: { label: '瑞典', good: 195, fair: 255 },
  FI: { label: '芬兰', good: 195, fair: 255 },
  PL: { label: '波兰', good: 190, fair: 250 },
  CH: { label: '瑞士', good: 190, fair: 250 },
  IE: { label: '爱尔兰', good: 190, fair: 250 },
  RO: { label: '罗马尼亚', good: 185, fair: 245 },
  IS: { label: '冰岛', good: 235, fair: 310 },
  ZA: { label: '南非', good: 250, fair: 330 },
  EG: { label: '埃及', good: 210, fair: 275 }
};
// 探针没给 region 时的兜底档：按"未知区域"给一条较宽的中等线
export const latencyFallback = { label: '未知区域', good: 160, fair: 215 };

// 离散度（p90 − p50）：越小越好。与机房地理位置无关，因此不分区
export const spread = { unit: 'ms', good: 25, fair: 50 };

// 丢包 / 重传率：0 与"非 0"是质变，不分区。4% 相当于 25 个包里丢 1 个，
// 与 48% 完全不是一回事，因此用 severe 把"普遍轻微"和"少数严重"分开。
export const loss = { unit: '%', good: 0, fair: 2, severe: 10 };

// 速度：越大越好。也受长肥管道限制（离得越远越难跑满），但目前没有足够数据
// 支撑分区，先给一条统一基准，等积累了各区域报告再拆。
export const speed = { unit: 'Mbps', good: 300, fair: 100, reverse: true };

export const gradeLabels = { good: '好', fair: '一般', bad: '差' };

// 离群判定：与中位数的偏差超过 mad 倍数即视为离群。
export const outlier = { madFactor: 3.5, speedDivisor: 5, speedFloor: 50, lossDanger: 5 };

export function latencyBand(region) {
  return latencyByRegion[String(region || '').toUpperCase()] || latencyFallback;
}
// 把 0-4 的色阶从「好 / 一般」两个边界推导出来，保证热力图与卡片档位口径一致
export function levelFromBand(value, band) {
  if (typeof value !== 'number') return 0;
  const { good, fair } = band;
  if (value <= good * 0.9) return 0;
  if (value <= good) return 1;
  if (value <= (good + fair) / 2) return 2;
  if (value <= fair) return 3;
  return 4;
}
