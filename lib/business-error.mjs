// 区分两类错误：
//   业务错误 —— 文案本身就是给人看的（参数不对、记录不存在、报告格式没认出来…），
//               应当原样回传给调用方。
//   其它异常 —— 服务端故障。node:fs 的 ENOENT/EACCES 会把 DATA_DIR 绝对路径和
//               系统用户名带进 message，node:net 的错误则是机器内部细节。
//               这些一律只进服务端日志，对外只给一句通用提示。
//
// 放在 lib/ 而不是各自定义：抛错的方不止 server.mjs —— parser、csv-parser、probe
// 都抛用户要看的文案，store 抛的是"节点不存在""已重复导入"这类。
// 约定必须由一处定义，否则漏标一处就等于把内部错误又漏出去了。

// 抛一个业务错误。message 会原样出现在接口响应里。
export function businessError(message) {
  return Object.assign(new Error(message), { business: true });
}

// 把第三方异常（fetch / JSON.parse / 解压…）转成业务错误，只保留可展示的上下文。
// 原始 message 一律丢弃：它是英文底层报错，且可能带内部地址。
export function asBusinessError(error, message) {
  return businessError(error?.message ? `${message}（${error.message}）` : message);
}

export const isBusinessError = error => Boolean(error?.business);
