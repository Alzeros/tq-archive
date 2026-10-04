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
   该页顶部的走势图有三个视图：**全部指标**（整机延迟 p50 / 丢包条数 / 回程速度）、
   **运营商延迟**、**运营商丢包线路**。后两者按电信 / 联通 / 移动分开画，
   用来回答「这台机器的移动是不是一直在绕」「某家的丢包从哪一份开始变」——
   整机口径会把三家的差异平均掉。数据来自 `/api/stats?group=report&split=carrier`。
5. 在「变化对比」选择同一节点的两份报告，查看各指标增减（默认只显示显著变化，见下）。

## 脚本直传

不经过链接，在被测服务器上跑完 TQ 直接把结果传到 TQ Hub：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Alzeros/tq-archive/main/scripts/run-with-hub.sh) \
  --hub=https://你的域名 --key=<API Key>
```

- Key 在侧边栏「API Key 管理」生成；脚本开跑前会先校验 hub 与 key。
- 检测原样运行官方 `runTcpQuality.sh`：不带其他参数出现官方选项菜单（回车即全选），带 `--all`、`-v4` 等参数则原样透传。
- 本次 CSV 经官方的 `TCPQUALITY_OUTPUT_DIR` 落到私有临时目录后上传；测试时间取 CSV 的修改时间（即报告时间）。
- 上传后进入「导入报告 → 脚本直传 · 待绑定」，选择节点后归档。同一台机器（主机名 + 出口 IP）绑定过一次后会自动推荐；没有记录时不预选，避免成批绑错。有推荐的条目可以用**「一键接受全部推荐」**批量归档 —— 只处理有推荐的，没有记忆的条目仍由人决定归属。
- 上传失败时 CSV 保存在 `~/.cache/tq-archive/failed/`，用 `--upload=文件` 重传。同一份数据按内容指纹去重，重复上传不会重复入队。
- CSV 五个维度都会解析，记录 key 与单位和链接导入一致，两种来源的报告可在同一条趋势线上对比。测速延迟按官方口径取 TLS 握手耗时的一半。
- 原始 CSV 随报告保留。解析规则升级后，服务启动时会自动重新解析已有的直传报告（含待绑定），新增的维度自动补齐。

### API Key 的两种权限

在「API Key 管理」创建时选择权限，两种互不通用：

| 权限 | 能做什么 | 典型用途 |
| --- | --- | --- |
| `upload` | 仅 `POST /api/upload-csv`，往待绑定队列写 | 跑在服务器上的测试脚本 |
| `read` | `GET /api/reports`、`/api/reports/{id}`、`/api/stats` | 自动化分析、导出数据 |

- **权限精确匹配**：上传 key 读不到任何报告数据，只读 key 也上传不了、关不掉节点、碰不到 Key 管理。
- 存量 key 没有权限字段，一律按 `upload` 处理 —— 升级不会让脚本机上的 key 凭空多出读权限。
- 读接口刻意只给报告数据：**不含原始 HTML/CSV、不含待绑定队列**（那里面有主机名与出口 IP）。
- 报告明细会剔除 `rawRows`（原始行文本，占体积大头且分析用不上）；需要原始文件请从网页下载。

### 聚合查询 `/api/stats`

明细接口要拉全量才能算账（17 份就是 2MB，换来十几个数字）。聚合接口把同样的口径搬到服务端，一次请求只回几十行。

```bash
# 区域横向对比：每台机器等权，不会被"报告多的机器"带偏
curl -H "X-Tq-Key: $READ_KEY" 'https://你的域名/api/stats?group=region'

# 某区域逐机明细，含分运营商 p50
curl -H "X-Tq-Key: $READ_KEY" 'https://你的域名/api/stats?group=node&region=HK'

# 单机时间序列（不展开 byCarrier，17 份 × 3 家太吵，需要时再用 group=node 看）
curl -H "X-Tq-Key: $READ_KEY" 'https://你的域名/api/stats?group=report&node=<id>'

# 跨机器看哪家运营商整体最差
curl -H "X-Tq-Key: $READ_KEY" 'https://你的域名/api/stats?group=carrier'
```

| 参数 | 取值 |
| --- | --- |
| `group` | `node` / `region` / `carrier` / `report`（必填） |
| `section` | `ipv4`（默认）/ `large4` / `ipv6` / `cernet` |
| `since` / `until` | ISO 日期，如 `2026-10-01` |
| `node` / `region` / `carrier` | 过滤 |

**汇总口径**：基本单位是**机器** —— 一台机器名下所有报告的记录倒在一起算；跨机器再汇总时每台等权（取各机器 p50 的分布），这样报告多的机器不会把区域数字带偏。每组返回延迟分位与离散度、按区域基准判出的 `level`、分运营商 p50、丢包线路数与 ≥10% 的重度条数、回程/去程速度中位数，以及 `worstMachines`（最差三台，便于下钻）。

`section` 只影响延迟与丢包：丢包在 `ipv4`/`ipv6`/`cernet` 取 `loss`、在 `large4` 取 `retrans`，两者口径不同不混算；速度始终取 `speedtest` 维度，与 `section` 无关。分位用 nearest-rank（下标 `floor(n×p)`，偶数样本取偏上的那个），与网页卡片同一套算法。

汇总只统计**启用的节点**（与界面一致），显式指定 `node=<停用节点>` 时仍会返回，便于排查。`since` / `until` 给纯日期时按北京时间当天闭区间（`00:00:00`~`23:59:59`）解释，所以 `until=2026-10-03` 包含 10-03 全天；明细读不出来的报告计入 `totals.skipped` 并列入 `unreadable`，数字变少不会无声无息。

## 变化对比的显著度门槛

同机两份报告之间 ±1~16ms 的日常抖动会产生几百行变化明细，把真正的信号（某方向丢包从 0 跳到 78%、测速腰斩）埋在中间。因此对比视图默认只显示**显著变化**，门槛集中在 `lib/thresholds.mjs` 的 `significance`：

| 指标 | 门槛 |
| --- | --- |
| 延迟（`latency` / `returnLatency` / `downloadLatency` 等） | 变化 ≥ 10ms |
| 丢包 / 重传（`loss` / `retrans` / `downloadRetransRate`） | 变化 ≥ 0.5%（0% → 1% 是从无到有，属质变） |
| 速度（回程 / 去程 / 上下行） | 变化 ≥ 20Mbps **且** ≥ 5% 相对幅度（两个条件都要满足，否则高速机上 2% 的抖动会被误报） |
| 其他（路由、可达、域名等文本） | 变化即显著 |

判定只看变化量，不看方向。标记由服务端在 `/api/compare` 里算好（`changes[].significant`），阈值表随响应下发，前端只负责筛选；取消勾选「只看显著变化」即可看到全部抖动，表格里会标出哪条显著、哪条在抖动范围内。实测同机两份报告 915 项变化里只有 1 项显著。

## 数据口径

- 归档时间以报告页内的**测试时间**为准，缺少时间时拒绝导入。
- **报告格式随探针是否支持 IPv6 而变**，两种都要接住：
  - 教育网回程：单栈是 4 格单列；双栈渲染成 8 格两列（`省,线路,延迟,丢包,/,线路,延迟,丢包`），拆成 `教育网IPv4` / `教育网IPv6` 两列。
  - 国际互联：双栈会渲染 `节点-IPv4` 与 `节点-IPv6` 两张目标同名的表，**IP 族必须写进记录 key**，否则第二张表会被去重当成重复记录整张丢弃。
- **`-1` 是「测量失败」的哨兵值**（`-1ms`，同行丢包通常 100%）。延迟 / 丢包 / 速度不可能为负，负值一律按 `unknown` 处理；若按数值处理，-1 会成为全场最小延迟，在热力图上被渲染成最优线路。
- **丢包**（IPv4 回程）与**重传**（大包回程、测速）分开存储，不合并为同一指标。
- 无法识别的值保留原文并标记 `unknown`，不按 0 参与计算。
- 单位统一为 `ms` / `%` / `Mbps`（`Gbps`、`Kbps` 自动换算）。
- 三网回程按固定列位解析：分隔符必须落在预期位置，否则整行拒绝解析并告警，不按位移猜测。
- **延迟基准按机房区域分档**（`lib/thresholds.mjs` 的 `latencyByRegion`）：物理距离决定回国延迟下限，同一个绝对阈值判所有区域等于把「离得远」误判成「线路差」。定档规则是先剔除明显绕路的运营商，再取良性线路延迟的 p90 向上取整到 5 作为「好」上限、「一般」= 好 × 1.5。已实测校准的区域在界面上标「已校准」，其余标「待校准」——**估算值不能当实测值看**。
- **国际互联用独立的全局档**：它测的是到全球 12 个节点的延迟，量级由目标分布决定，与机房离中国多远无关（各实测区域 p50 都在 140–180ms）。
- 原始 HTML 一并留存，便于回溯核对；解析规则升级后启动时会自动重解析（HTML 与 CSV 各自按版本号判断）。

## 备份与恢复

这个工具的全部价值就是 `data/` 里累积的历史：节点、报告明细、原始 HTML / CSV、待绑定队列与 API Key。**API Key 管理页底部的「数据备份」**把整个 `data/` 打成 `tq-hub-backup-<时间>.tar.gz` 一次下载走（登录用户专用）：

```bash
# 也可以直接调接口，拿到归档文件
curl -b cookie.txt -o backup.tar.gz https://你的域名/api/export
```

归档内的 `README-备份说明.txt` 记录了报告数、Key 数与目录含义。恢复就是把归档里的 `data/` 覆盖回目标机后重启：

```bash
sudo systemctl stop tq-archive
tar -xzf tq-hub-backup-2026-10-05-04-41-28.tar.gz --strip-components=0 -C /tmp/restore
sudo rsync -a --delete /tmp/restore/data/ /opt/tq-archive/data/
sudo systemctl start tq-archive
```

> ⚠ 归档内含 **API Key 明文**（`data/keys.json`），以及待绑定队列里的**主机名与出口 IP**。请只存放在可信位置，不要外传或提交到代码仓库。想分享数据副本给别人分析，用只读 Key 调 `/api/reports` 或 `/api/stats`，不要给整库归档。

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
