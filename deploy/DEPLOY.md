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
3. **配置账号密码**（不配则不启用登录，等于全网公开，务必配）：

```bash
sudo install -m 600 -o root -g root /dev/null /etc/tq-archive.env
sudo tee /etc/tq-archive.env > /dev/null <<'EOF'
AUTH_USER=admin
AUTH_PASSWORD=换成你自己的强密码
AUTH_SECURE=1
ALLOWED_HOSTS=127.0.0.1:4173,tq.example.com
ALLOWED_ORIGINS=https://tq.example.com
EOF
sudo systemctl restart tq-archive
```

4. **nginx 不要启用 basic auth**。示例配置里已移除 `auth_basic`；
   若你之前的配置还留着，删掉这两行并 reload，否则浏览器会先弹框、永远到不了应用内登录页：

```bash
sudo sed -i '/auth_basic/d' /etc/nginx/conf.d/tq-archive.conf
sudo nginx -t && sudo systemctl reload nginx
```

## 验证

```bash
# 未登录应返回 302 跳转到 /login（不是 401 弹框）
curl -sI https://tq.example.com/ | head -3

# 接口未登录应返回 401 JSON
curl -s https://tq.example.com/api/session

# 登录后拿到会话
curl -s -c /tmp/tq.cookie -X POST https://tq.example.com/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"你的密码"}'

# 用会话访问主界面，应 200
curl -s -b /tmp/tq.cookie -o /dev/null -w '%{http_code}\n' https://tq.example.com/

sudo journalctl -u tq-archive -f
```

登录失败 10 次会锁定该来源 IP 5 分钟，可在日志中看到。

## 忘记密码

改 `/etc/tq-archive.env` 后 `sudo systemctl restart tq-archive` 即可，
重启会清空所有会话。

首次进入后依次点一次「从探针同步节点」和「导入报告」，确认外部依赖可达。

## 日常更新

```bash
sudo -u tq bash /opt/tq-archive/deploy/deploy.sh
```

脚本会 `git fetch` + `--ff-only` 合并 + 重启 + 健康检查，失败时打印 `systemctl status`。

## 容易踩的坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 仍弹出浏览器原生账号框 | nginx 还开着 `auth_basic` | 删掉 `auth_basic` 两行后 `nginx -t && systemctl reload nginx` |
| 打开站点直接进主界面，没有登录页 | 未配置 `AUTH_USER` / `AUTH_PASSWORD` | 写 `/etc/tq-archive.env` 后重启；不配等于不启用认证 |
| 登录后立刻又回到登录页 | 走 https 但没设 `AUTH_SECURE=1`，Cookie 被浏览器丢弃 | 补上该变量并重启 |
| 登录页能开但接口全 401 | Cookie 没带上，检查 systemd 日志与浏览器控制台 | 确认 `AUTH_SECURE=1` 且未用 http 访问 |
| 域名访问 403，curl 本机正常 | `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` 没改成域名 | 改 env 文件后重启 |
| 提示"尝试过多，请稍后再试" | 5 分钟内登录失败 10 次触发锁定 | 等 5 分钟，或重启服务清空计数 |
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
