# Mail Pickup

为 AliasHub 产出的 Outlook/iCloud ChatGPT 成品账号签发独立取件链接，并把所选卡密一键上货到联动小铺。`pickup.example.com` 是买家取件网站，不要求成品账号使用 `@example.com`。

## 功能

- 从 AliasHub 一键导入 Outlook Plus 地址、Outlook 官方别名或 iCloud 别名。
- 管理后台支持仅凭邮箱批量生成或查询固定取件链接，可选附带账号密码。
- 自动匹配 AliasHub 中的源邮箱，每 15 秒触发收件扫描并同步到买家取件箱。
- 每个邮箱使用独立 HMAC 取件令牌，支持立即轮换和停用。
- 买家页面每 10 秒刷新邮件，只返回纯文本正文。
- 管理页自动读取联动小铺全部卡密商品和分类，由管理员选择对应渠道后上货。
- 自动同步联动小铺已售卡密；本地删除已售记录不会删除邮箱、邮件或取件链接。
- SQLite WAL 持久化，默认保留 30 天且每个邮箱最多 200 封邮件。

## 本地运行

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
set -a
. ./.env
set +a
python app.py
```

也可以从仓库根目录运行完整 Compose 部署：

```bash
./scripts/setup-local.sh --full
docker compose -f compose.yaml -f compose.full.yaml up -d --build
```

`PICKUP_PUBLIC_BASE_URL`、`PICKUP_EMAIL_DOMAIN`、入站令牌和管理员密码必须
按实际部署配置。联动小铺功能可通过后台登录建立会话；商品 ID、图片 URL、代理、
CDP 地址和浏览器配置均从环境变量读取，不写入源码。

## 本地验证

```bash
python3 -m unittest discover -s tests -v
```

## 部署地址示例

- 买家取件：`http://127.0.0.1:4190/?token=...`
- 最新邮件 JSON API：`http://127.0.0.1:4190/api/query.php?mail=...&pwd=...&limit=1`
- 管理后台：`http://127.0.0.1:4190/admin`
- Cloudflare Email Worker 投递：`http://127.0.0.1:4190/api/inbound`

## 最新一封邮件 API

后台会直接生成可导入的 GET 接口，无需打开页面：

```text
GET http://127.0.0.1:4190/api/query.php?mail=邮箱&pwd=取件TOKEN&limit=1
```

只查询指定时间之后收到的邮件，可追加 `timestamp`：

```text
GET http://127.0.0.1:4190/api/query.php?mail=邮箱&pwd=取件TOKEN&limit=1&timestamp=1785834000
```

`timestamp` 支持 Unix 秒、Unix 毫秒、ISO 8601；筛选条件是邮件接收时间严格晚于该时间。

API 的时间参数和时间字段统一使用北京时间（`Asia/Shanghai`，UTC+8）。不带时区的日期时间按北京时间解释；Unix 秒和毫秒仍表示绝对时间。JSON 时间字段返回带 `+08:00` 的 ISO 8601，兼容接口的 `saved_at` 保持 `YYYY-MM-DD HH:mm:ss` 格式但内容为北京时间。
传入时间戳后按接收时间从早到晚返回，因此 `limit=1` 得到该时间之后到达的第一封新邮件。
也兼容同义参数 `after`、`since`、`start_time`。

返回格式兼容 `query.php?mail=...&pwd=...&limit=1` 类型的取件接口：

```json
{
  "status": "success",
  "data": [{
    "body": "Enter this temporary verification code to continue: 123456",
    "from": "OpenAI <noreply@openai.com>",
    "saved_at": "2026-08-04 09:00:00",
    "subject": "Your temporary ChatGPT login code",
    "to": "buyer@example.com"
  }]
}
```

暂时没有邮件时仍返回 HTTP 200，`data` 是空数组，方便调用方轮询。
原来的 `GET /api/latest?token=...` 和 `GET /api/public/mailbox/{token}/latest` 继续兼容。

## 从 AliasHub 一键导入

打开 `http://127.0.0.1:4180/`，进入“ChatGPT 注册”页面并切换到“注册账号”：

1. 勾选要出售的成品账号。
2. 点击“上架取件站”。
3. AliasHub 把账号邮箱、已配置的密码和套餐标签传给 Mail Pickup，不上传 AT。
4. 成功后账号会出现在取件管理后台。
5. 在联动小铺商品下拉框中选择对应分类和渠道，再勾选账号点击“上货到所选商品”。

后端接口为 `POST /api/pickup/import-accounts`，请求体是 AliasHub 注册账号 ID：

```json
{"ids":[101,102]}
```

重复上架会更新标签和可用密码，同时保留原取件链接；AT 不会进入取件站。

## 从管理后台批量生成链接

打开 `http://127.0.0.1:4190/admin`，在“批量生成取件链接”中每行填写一条：

```text
name@example.com
user@example.com----可选账号密码
```

外部邮箱不需要预先存在于 AliasHub。只生成链接不需要账号密码；未配置收件凭据时，
生成的是可正常打开但不会收到邮件的空取件箱。重复导入会返回原取件链接，不会轮换
token。输出格式为 `邮箱----取件链接`。

管理后台复用 AliasHub 的管理员账号密码。运行时复用现有
`NF_EMAIL_RECORD_TOKEN` 作为 Worker 投递密钥，并使用 AliasHub 的
`DATA_ENCRYPTION_KEY` 生成不可伪造的取件令牌。

一键上货使用的每行卡密格式：

```text
账号：name+gpt-xxxx@outlook.com----密码：configured-password----取件链接：http://127.0.0.1:4190/?token=...
```

账号没有已配置密码时，卡密继续使用 `邮箱 取件链接` 格式。
