const axes = Object.freeze({ access: ['ct', 'cu', 'cm', 'cernet'], usage: ['intl', 'speed', 'bulk'] });

export function priorityView(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('视角必须为对象');
  const weights = {};
  const shares = {};
  for (const key of Object.keys(input)) if (!Object.hasOwn(axes, key)) throw new TypeError(`未知视角轴：${key}`);
  for (const [axis, keys] of Object.entries(axes)) {
    const supplied = Object.hasOwn(input, axis) ? input[axis] : {};
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new TypeError(`无效视角轴：${axis}`);
    for (const key of Object.keys(supplied)) if (!keys.includes(key)) throw new TypeError(`未知权重：${key}`);
    weights[axis] = Object.fromEntries(keys.map(key => {
      const value = Object.hasOwn(supplied, key) ? supplied[key] : 1;
      if (!Number.isFinite(value) || value < 0.25 || value > 4) throw new RangeError(`权重 ${axis}.${key} 必须在 [0.25,4]`);
      return [key, value];
    }));
    const sum = Object.values(weights[axis]).reduce((total, value) => total + value, 0);
    shares[axis] = Object.fromEntries(keys.map(key => [key, weights[axis][key] / sum]));
  }
  const id = Object.entries(shares).map(([axis, values]) => `${axis}:${Object.values(values).map(value => Number(value.toPrecision(12))).join(',')}`).join('|');
  const isDefault = Object.values(shares).every(values => new Set(Object.values(values)).size === 1);
  return { id, label: isDefault ? '默认视角' : '自定义视角', weights, shares };
}

export function parsePriorityView(params = new URLSearchParams()) {
  if (!(params instanceof URLSearchParams) || params.toString().length > 512) throw new TypeError('无效或过长的视角参数');
  const input = {};
  for (const key of params.keys()) if (!Object.hasOwn(axes, key)) throw new TypeError(`未知参数：${key}`);
  for (const [axis, keys] of Object.entries(axes)) {
    const values = params.getAll(axis);
    if (!values.length) continue;
    if (values.length !== 1 || !values[0]) throw new TypeError(`空值或重复参数：${axis}`);
    const pairs = values[0].split(',');
    if (pairs.length > keys.length) throw new TypeError(`权重过多：${axis}`);
    input[axis] = {};
    for (const pair of pairs) {
      const match = /^([a-z]+):((?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)$/i.exec(pair);
      if (!match || !keys.includes(match[1]) || Object.hasOwn(input[axis], match[1])) throw new TypeError(`无效或重复权重：${pair}`);
      input[axis][match[1]] = Number(match[2]);
    }
  }
  return priorityView(input);
}

export const priorityPresets = Object.freeze({
  default: {},
  mobile: { access: { ct: 0.25, cu: 0.25, cm: 1, cernet: 0.25 } },
  telecom: { access: { ct: 1, cu: 0.25, cm: 0.25, cernet: 0.25 } },
  bandwidth: { usage: { intl: 0.25, speed: 1, bulk: 1 } }
});
