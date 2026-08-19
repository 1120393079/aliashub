# Payment Link Extractor

AliasHub 自带的独立 PayPal 提链服务。源码、Web 工作台和 API 均保留在本目录，支持 OAICS 与 Stripe Checkout (`cs_*`) 两种结账流程。

## 功能

- PayPal BA 链接提取与重定向解析
- DE / EUR、TR / USD、GB / GBP、US / USD、BR / BRL 账单组合
- Checkout Proxy 与 Update Proxy 独立配置和轮换
- 异步任务、进度事件、取消、重试、批量删除与 WebSocket 推送
- IPRocket 订阅导入、代理探测和可选链式代理桥
- 密码保护的完整 Web 工作台和 JSON API

## 随 AliasHub 启动

在仓库根目录运行：

```bash
./scripts/setup-local.sh --full
docker compose -f compose.yaml -f compose.full.yaml up -d --build
```

工作台仅发布到 `http://127.0.0.1:18794`。AliasHub 通过 Compose 内网地址 `http://payment-link-extractor:18794` 调用 API，两端共享根目录 `.env` 中自动生成的 `PAYMENT_LINK_SERVICE_PASSWORD`。

## 独立运行

Python 3.11 或更新版本：

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m payment_link_extractor.web
```

也可以单独构建容器：

```bash
docker build -t payment-link-extractor .
docker run --rm \
  -e OPLL_WEB_PASSWORD=replace-with-a-long-random-value \
  -p 127.0.0.1:18794:18794 \
  -v "$PWD/data:/app/data" \
  payment-link-extractor
```

默认原生监听地址为 `127.0.0.1:18794`；容器镜像将监听地址设为 `0.0.0.0`，但示例和 Full Compose 都只在宿主机回环地址发布端口。

## 认证和健康检查

所有 `/api/*` 请求使用 `X-Workbench-Password` 请求头。WebSocket 在连接后发送相同密码。示例：

```bash
curl -H "X-Workbench-Password: $PAYMENT_LINK_SERVICE_PASSWORD" \
  http://127.0.0.1:18794/api/health
```

主要接口：

- `GET /api/health`、`GET /api/defaults`
- `GET|POST /api/tasks`
- `GET|DELETE /api/tasks/<task_id>`
- `POST /api/tasks/<task_id>/cancel`
- `POST /api/tasks/<task_id>/retry`
- `POST /api/tasks/<task_id>/resolve-paypal`
- `POST /api/tasks/bulk-delete`
- `GET /api/proxy/source`、`POST /api/proxy/test`
- `GET /ws/tasks`

## 配置与数据

所有选项及去敏默认值见 `.env.example`。任务中的 Access Token 和代理由 AliasHub 按请求传入，不写入源码或镜像。服务任务保存在内存中；Full Compose 仅把运行日志等文件写入根目录 `data/payment-link-extractor/`。

Web 服务会同时启动 `iprocket_chain_bridge.py`，因此 IPRocket、IPRoyal 和
1024Proxy 格式可直接使用。默认直接连接所选上游代理；只有上游必须经
SOCKS5 前置线路访问时，才配置可达的 `IPROCKET_PRE_PROXY_HOST` /
`IPROCKET_PRE_PROXY_PORT`。订阅地址和代理凭据只能放在未提交的运行配置中。
