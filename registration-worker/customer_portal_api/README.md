# Customer Portal API

独立的 C 端/管理端后端服务，复用当前仓库已有的平台注册内核、平台元数据、任务运行时、账号资产、代理和系统能力。

## 已实现能力

- 认证接口：登录、刷新 token、登出、当前用户
- 用户端接口：
  - `GET /api/app/platforms`
  - `GET /api/app/config/options`
  - `GET /api/app/products`
  - `POST /api/app/tasks/register`
  - `GET /api/app/tasks`
  - `GET /api/app/tasks/{task_id}`
  - `GET /api/app/tasks/{task_id}/events`
  - `GET /api/app/tasks/{task_id}/logs/stream`
  - `GET /api/app/orders`
  - `POST /api/app/orders`
  - `GET /api/app/orders/{order_no}`
  - `POST /api/app/payments/{order_no}/submit`
  - `GET /api/app/subscriptions`
  - `GET /api/app/profile`
  - `PATCH /api/app/profile`
- 管理端接口：
  - 用户、角色、权限、平台授权、商品目录
  - 平台、配置、注册任务、任务查询、任务日志
  - 账号、平台动作、代理、Solver 状态
- 支付接口：
  - `POST /api/payment/callback/{channel_code}`

## 目录

```text
customer_portal_api/
├── app/
│   ├── routers/
│   ├── services/
│   ├── bootstrap.py
│   ├── config.py
│   ├── db.py
│   ├── deps.py
│   ├── models.py
│   └── security.py
├── Dockerfile
├── docker-compose.yml
├── requirements.txt
└── main.py
```

## 本地启动

### 1. 安装依赖

在仓库根目录执行：

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

如果你只想按照新项目路径安装，也可以：

```bash
pip install -r customer_portal_api/requirements.txt
```

### 2. 配置环境变量

复制环境变量模板：

```bash
cp customer_portal_api/.env.example customer_portal_api/.env
```

Generate independent values for the two required secrets, then place them in
the copied file:

```bash
openssl rand -hex 32  # PORTAL_JWT_SECRET
openssl rand -hex 16  # PORTAL_ADMIN_PASSWORD
```

常用变量：

- `PORTAL_JWT_SECRET`
- `PORTAL_ADMIN_USERNAME`
- `PORTAL_ADMIN_PASSWORD`
- `PORTAL_ADMIN_EMAIL`
- `PORTAL_START_SOLVER`
- `ACCOUNT_MANAGER_DATABASE_URL`

### 3. 启动服务

在仓库根目录执行：

```bash
source .venv/bin/activate
export $(grep -v '^#' customer_portal_api/.env | xargs)
python -m uvicorn customer_portal_api.main:app --host 0.0.0.0 --port 8100 --reload
```

接口文档：

- Swagger UI: `http://127.0.0.1:8100/docs`
- OpenAPI JSON: `http://127.0.0.1:8100/openapi.json`

管理员用户名默认为 `admin`，密码没有默认值，必须通过
`PORTAL_ADMIN_PASSWORD` 设置。首次启动会把配置的管理员写入数据库。

## Docker 部署

在仓库根目录执行：

```bash
docker compose --env-file customer_portal_api/.env \
  -f customer_portal_api/docker-compose.yml up --build
```

服务默认监听：

- `http://127.0.0.1:8100`

## 设计说明

- 新项目复用当前仓库已有的平台注册和任务执行内核，不重新实现平台插件逻辑
- 新项目自己的用户、刷新 token、平台授权、订单、订阅、任务归属表会和现有业务表共用同一个 SQLite 数据库
- 用户端注册接口会创建真实注册任务，并通过任务归属表限制用户只能看到自己的任务
- 支付链路已包含商品种子、下单、提交支付、支付回调、订阅开通和平台注册权限开通
