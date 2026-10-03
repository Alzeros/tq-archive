# TQ Hub

把 TcpQuality 报告链接归集到探针节点，按测试时间累积历史，对比任意两次报告的变化，
并对单份报告给出延迟、丢包、速度的分布与异常提示。

## 运行

```bash
npm start
```

打开 http://127.0.0.1:4173 。数据保存在 `data/`（`database.json` 为索引，`data/reports/` 存结构化明细，`data/raw/` 保存原始报告 HTML / CSV，`data/csv-pool/` 是待绑定的直传 CSV），不依赖数据库。

## 使用流程

1. 点「从探针同步节点」，按探针 UUID 拉取节点列表（默认读取 `https://node.cnsr.site/config.json` 指向的后端）。
2. 在「导入报告」粘贴 `https://tcpquality.ibsgss.uk/r/xxxx` 链接，先预览解析结果。
3. 选择归属节点后确认归档；重复链接或重复内容会被拒绝。
4. 在「历史报告」查看某节点历次报告，并打开任意一份看完整指标表；误归档可用「删除」移除。
5. 在「变化对比」选择同一节点的两份报告，查看各指标增减。

## 脚本直传

不经过链接，在被测服务器上跑完 TQ 直接把结果传到 TQ Hub：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Alzeros/tq-archive/main/scripts/run-with-hub.sh) \
  --hub=https://你的域名 --key=<API Key>
```

- Key 在侧边栏「API Key 管理」生成；脚本开跑前会先校验 hub 与 key。
- 检测原样运行官方 `runTcpQuality.sh`：不带其他参数出现官方选项菜单（回车即全选），带 `--all`、`-v4` 等参数则原样透传。
- 本次 CSV 经官方的 `TCPQUALITY_OUTPUT_DIR` 落到私有临时目录后上传；测试时间取 CSV 的修改时间（即报告时间）。
- 上传后进入「导入报告 → 脚本直传 · 待绑定」，选择节点后归档。同一台机器（主机名 + 出口 IP）绑定过一次后会自动推荐；没有记录时不预选，避免成批绑错。
- 上传失败时 CSV 保存在 `~/.cache/tq-archive/failed/`，用 `--upload=文件` 重传。同一份数据按内容指纹去重，重复上传不会重复入队。
- CSV 五个维度都会解析，记录 key 与单位和链接导入一致，两种来源的报告可在同一条趋势线上对比。测速延迟按官方口径取 TLS 握手耗时的一半。
- 原始 CSV 随报告保留。解析规则升级后，服务启动时会自动重新解析已有的直传报告（含待绑定），新增的维度自动补齐。

## 数据口径

- 归档时间以报告页内的**测试时间**为准，缺少时间时拒绝导入。
- **丢包**（IPv4 回程）与**重传**（大包回程、测速）分开存储，不合并为同一指标。
- 无法识别的值保留原文并标记 `unknown`，不按 0 参与计算。
- 单位统一为 `ms` / `%` / `Mbps`（`Gbps`、`Kbps` 自动换算）。
- 三网回程按固定列位解析：分隔符必须落在预期位置，否则整行拒绝解析并告警，不按位移猜测。
- 原始 HTML 一并留存，便于回溯核对。

## 结构

| 文件 | 作用 |
| --- | --- |
| `server.mjs` | 本地 HTTP 服务与 API |
| `lib/auth.mjs` | 账号校验与会话 Cookie |
| `lib/csv-parser.mjs` | 脚本直传的 CSV 转结构化记录（与链接导入同一套 key 与单位） |
| `lib/insight.mjs` | 单份报告洞察：指标卡、相对离群异常、省份×运营商热力图 |
| `lib/parser.mjs` | 报告 HTML 转结构化记录、两次报告对比 |
| `lib/probe.mjs` | 探针节点同步 |
| `lib/store.mjs` | 本地 JSON 与原始报告存储 |
| `lib/keys.mjs` | 脚本直传用的 API Key |
| `lib/thresholds.mjs` | 主观评级阈值（可调），异常检测不依赖它 |
| `scripts/run-with-hub.sh` | 被测服务器上运行：跑官方 TQ 并直传结果 CSV |
| `public/` | 前端界面 |
| `test/` | 解析器、存储、认证与洞察测试（`npm test`） |

`database.json` 只保留列表与去重所需的元数据，明细按报告拆分到 `data/reports/{id}.json`，
避免写入耗时随报告数线性增长。v1 库在启动时自动迁移。

服务仅监听 `127.0.0.1`，并校验 Host 与 Origin，不对外网开放。

## 登录

未设置 `AUTH_USER` / `AUTH_PASSWORD` 时不启用登录，本机可直接使用。
反代到公网时必须配置，登录由应用自身处理（`/login` 页面 + `HttpOnly` 会话 Cookie）：

```bash
AUTH_USER=admin
AUTH_PASSWORD=强密码
AUTH_SECURE=1        # 走 https 时必开，否则 Cookie 会被浏览器丢弃
```

nginx 侧不要再启用 `auth_basic`，否则浏览器会先弹原生账号框，到不了应用内登录页。
完整步骤见 `deploy/DEPLOY.md`。
