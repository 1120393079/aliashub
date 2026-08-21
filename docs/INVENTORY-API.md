# nvtokens 库存 API 对接

AliasHub 通过服务端代理调用 nvtokens 的三个接口，不在浏览器中保存或发送
`x-api-key`：

- `POST /api/inventory/cards/import`：账号入库
- `POST /api/inventory/mailboxes/import`：邮箱凭证匹配
- `POST /api/inventory/cards/pool`：提交并直接入池

推荐在「系统设置 → nvtokens 库存」中填写和维护 Key；「验证码中心」或「注册账号 →
库存 API」弹窗仍保留状态查看和临时操作入口。Key 使用 `DATA_ENCRYPTION_KEY` 对应的
AES-256-GCM 加密写入 SQLite；页面只显示是否已配置。
三个上游地址由服务端锁定，浏览器不能修改，数据库中遗留的自定义地址也不会被读取。

## 一键流程

1. 在「注册账号」选择账号，打开「库存 API」；留空账号 JSON，服务端会读取 AT/RT，
   不把凭据返回给浏览器。
2. 在「验证码中心」按源头邮箱筛选，切换到「导入邮箱凭证」，粘贴三种支持格式之一。
   `邮箱 空格 HTTPS 取件链接` 会自动规范化为 nvtokens 接受的
   `邮箱----HTTPS 取件链接`。选择「全部源头邮箱」且不粘贴内容时，会一次匹配全部
   active 链接取件邮箱。粘贴、数组和自动匹配三种方式均最多 1000 个，超限不会
   截断或部分提交；结果中的 `source_count` 表示本次实际提交的邮箱凭证数。
3. 直接入池必须填写 `price_yuan`；nvtokens 检测不通过的账号不会进入号池。

上游返回 HTTP 201 但全部被拒绝时，AliasHub 仍按 `accepted/rejected` 统计显示，
不能只依据 HTTP 状态判断成功。
从账号池批量提交时还会返回 `requested_count`、`source_count`、
`local_failed_count` 和有限的 `credential_failures`；本地凭据读取失败不会被算成
上游拒绝，也不会显示成纯成功。

「测试连接」会携带 `x-api-key` 向账号入库接口发送空 JSON 对象。这个探针不包含账号，
不会创建库存；只有鉴权请求成功后才更新连接时间。公开的 `/schema` 仅用于查看协议，
不能用于判断 Key 是否有效。

## 配置项

Key 可通过弹窗配置，也可使用环境变量预置：

- `NVTOKENS_API_KEY`
- `NVTOKENS_API_TIMEOUT_MS`

生产环境固定使用以下三个地址：

- `https://nvtokens.com/api/inventory/cards/import`
- `https://nvtokens.com/api/inventory/mailboxes/import`
- `https://nvtokens.com/api/inventory/cards/pool`

只有可信的服务端测试环境可以设置 `NVTOKENS_ALLOW_CUSTOM_ENDPOINTS=true`，再通过
下列环境变量覆盖地址；普通管理台请求即使知道路由也不能修改它们：

- `NVTOKENS_CARDS_IMPORT_URL`
- `NVTOKENS_MAILBOXES_IMPORT_URL`
- `NVTOKENS_CARDS_POOL_URL`

地址只从固定常量或显式启用的服务端环境变量读取，数据库 URL 设置会被忽略。
不要把 Key 放在 URL、前端代码、提交记录或日志中。
