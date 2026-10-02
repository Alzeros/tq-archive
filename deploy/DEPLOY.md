# 部署清单

目标环境：Debian / Ubuntu，Node >= 22，项目固定在 `/opt/tq-archive`。

## 一次性准备

```bash
# 1. 系统用户
sudo useradd --system --home /opt/tq-archive --shell /usr/sbin/nologin tq

# 2. 代码
sudo mkdir -p /opt/tq-archive && sudo chown tq:tq /opt/tq-archive
sudo -u tq git clone git@github.com:Alzeros/tq-archive.git /opt/tq-archive

# 3. 数据目录（必须在 chown 之前建好，否则 tq 无权写入）
sudo mkdir -p /opt/tq-archive/data
sudo chown -R tq:tq /opt/tq-archive

# 4. systemd
sudo cp /opt/tq-archive/deploy/tq-archive.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tq-archive
sudo systemctl status tq-archive
```

## 反代到域名

1. 证书：`certbot --nginx -d tq.example.com`
2. 复制 `deploy/nginx.conf.example` 到 `/etc/nginx/conf.d/tq-archive.conf`，改 `server_name` 与证书路径
3. 生成密码：`htpasswd -c /etc/nginx/.tq htqadmin`
4. **改 systemd 的白名单**（漏了这步后端一律 403）：

```bash
sudo systemctl edit tq-archive
```

```ini
[Service]
Environment=ALLOWED_HOSTS=127.0.0.1:4173,tq.example.com
Environment=ALLOWED_ORIGINS=https://tq.example.com
```

```bash
sudo systemctl restart tq-archive
```

## 验证

```bash
# 本机直连（绕过 nginx 也能通，说明后端本身健康）
curl -s http://127.0.0.1:4173/api/state | head -c 200

# 域名访问（应返回 JSON；401 说明 basic auth 生效，403 说明白名单没改对）
curl -sI https://tq.example.com/api/state

# 看日志
sudo journalctl -u tq-archive -f
```

首次进入后依次点一次「从探针同步节点」和「导入报告」，确认外部依赖可达。

## 日常更新

```bash
sudo -u tq bash /opt/tq-archive/deploy/deploy.sh
```

脚本会 `git fetch` + `--ff-only` 合并 + 重启 + 健康检查，失败时打印 `systemctl status`。

## 容易踩的坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 域名访问 403，curl 本机正常 | `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` 没改成域名 | `systemctl edit` 加上后重启 |
| nginx 日志 401 | basic auth 未输入或 htpasswd 文件权限 | 正常行为，确认已生成 `/etc/nginx/.tq` |
| 后端起不来，日志 EACCES | `/opt/tq-archive/data` 属主不是 `tq` | `chown -R tq:tq /opt/tq-archive` |
| 「从探针同步节点」超时 | 服务器无法访问 `node.cnsr.site` 或其 WebSocket 后端 | 检查出网与 DNS；该功能依赖公网 |
| 「导入报告」失败 | 无法访问 `tcpquality.ibsgss.uk` | 同上 |
| 更新脚本无反应 | 本地已在最新，会直接退出 | 属正常行为 |

## 数据与备份

真实数据全在 `/opt/tq-archive/data/`：

- `database.json` — 索引（节点 + 报告元数据）
- `reports/{id}.json` — 结构化明细
- `raw/{id}.html` — 原始报告 HTML

该目录不在 Git 中，`git pull` 不会覆盖它。备份直接打包整目录即可：

```bash
sudo tar czf tq-data-$(date +%F).tar.gz -C /opt/tq-archive data
```

v1 格式的库在启动时会自动迁移到新结构，无需手工处理。
