# AliasHub 安全整理与发布

本项目的源码目录和运行数据目录是分开的。整理代码时只处理
`/opt/alias-hub` 中的源码、测试和构建产物，不直接清空或复制生产数据库。

## 运行真相

- systemd：`alias-hub.service`
- 服务目录：`/opt/alias-hub`
- 生产数据库：`/var/lib/alias-hub/outlook-alias-hub.db`
- 静态入口：`/opt/alias-hub/dist/index.html`
- 公网前缀：`/alias-hub/`

`data/`、`runtime/`、`audit/`、`release/`、`.env` 和各类缓存属于本地运行态，
不要作为源码整理的一部分删除或覆盖。

## 整理前检查

先记录服务、流水线和数据库状态，并使用 SQLite 在线备份（不要直接复制
WAL 模式下的主库文件）：

```bash
umask 077
backup_dir=/root/alias-hub-backups/$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 700 "$backup_dir"
systemctl show alias-hub.service -p MainPID -p ActiveState -p SubState
sqlite3 /var/lib/alias-hub/outlook-alias-hub.db \
  ".timeout 10000" \
  ".backup '$backup_dir/outlook-alias-hub.db'"
sqlite3 "$backup_dir/outlook-alias-hub.db" \
  'PRAGMA integrity_check;'
```

`.env`、worker 配置和其他运行态凭据应另行以 600 权限备份，不能放进公开
源码归档。WAL 模式副本的校验应在隔离备份目录中执行；不要对生产库执行
`wal_checkpoint` 或直接复制主库文件。

流水线处于 `queued`、`running` 或 `cancel_requested` 时，默认不要重启服务或
删除别名。需要维护窗口时，优先通过工作站取消流水线，等待其进入终态，再
停止 systemd。若流水线长期停在持久化的 `retry_wait` 且必须发布修复，只能在完成
SQLite 在线备份后做一次有界重启；重启前记录 item 的 `stage`、`retry_count` 和
`updated_at`，重启后确认同一 pipeline/item 的时间与重试计数继续推进。不能在
`browser_running`、别名创建/删除或账号写入阶段主动重启。

## 验证顺序

在源码副本中运行：

```bash
git diff --check
npm run test:node
npm run build
```

发布前确认 `dist` 目录为 755、文件为 644，并逐一请求 `index.html` 引用的
JS/CSS 资源。生产构建必须使用默认的 `/alias-hub/` 基路径；只有本机根路径
测试才使用 `npm run build:local`。

源码目录本身为 `root:alias-hub` 且不向 other 开放，因此每个新建的后端运行时文件
必须至少为 `640 root:alias-hub`，新目录必须至少为 `750 root:alias-hub`。重启前用
运行用户验证所有新增 import 都可读，例如：

```bash
runuser -u alias-hub -- test -r /opt/alias-hub/server/inventory-api-service.js
runuser -u alias-hub -- node --check /opt/alias-hub/server/inventory-api-service.js
```

不要只用 root 跑测试；root 能读取 `600 root` 文件，而 systemd 的 `alias-hub` 用户不能。

正式替换使用 `scripts/deploy-production.sh`，它会先做 SQLite 快照和完整代码
备份，失败时恢复代码并重启服务。该脚本要求显式设置 `DEPLOY_DIR`、
`DATABASE_PATH`、`BACKUP_ROOT`、`SERVICE_NAME` 和 `HEALTH_URL`。

## 业务不变量

- 有资格的账号进入账号池并继续后续提链流程。
- 母号已达到 10 个 Mail.com 地址时，主地址轮换只允许先删除一个明确失败/无优惠且未受保护的普通官方别名，再创建 replacement；任何路径都不得发送第 11 个创建请求。
- `Plus`、`blocked`、已提链、协议成功/不确定、默认/母号、活动注册或取件库存中的地址永不自动删除。
- `blocked` 账号和对应历史记录保留，不由流水线自动删除。
- 只有用户从账号池删除失效账号后，才释放对应 Mail.com 官方别名保护并允许
  轮换/重建。
- 删除账号失败时不释放别名；删除成功后释放结果通过 API 返回，便于界面核对。

库存 API Key 只允许通过管理台「库存 API」配置，使用 `DATA_ENCRYPTION_KEY` 加密写入
生产库；不要把 Key 写入源码、`.env` 以外的公开归档、截图或日志。Key 发生泄露时，
先在 nvtokens 侧撤销/重建，再在管理台清除旧 Key 并保存新 Key。

任何后端重构都必须保留上述状态、历史记录和 `released_mailcom_blocked` /
`resumed_mailcom_slots` 返回字段。
