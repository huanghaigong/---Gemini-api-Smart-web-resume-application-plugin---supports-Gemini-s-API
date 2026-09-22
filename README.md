# ---Gemini-api-Smart-web-resume-application-plugin---supports-Gemini-s-API
这是一个支持chrome内核浏览器的插件，它的作用是智能填写网络建立申请，接入Gemini的免费api进行各大网站的简历申请的识别填写，可以在文本中提前写好信息进行自动填写
This is a plugin that supports Chrome-based browsers. Its job is to smartly fill out online application forms, using Gemini's free API to recognize and fill in resumes for various websites. You can even pre-write your info in the text for automatic filling.
# Cloudflare Worker 中转 Gemini API · 部署指南

让插件通过你自己的域名访问 Gemini，**本机不再需要开代理**。原理：请求先到 Cloudflare 边缘服务器（全球节点，能直连 Google），由 Worker 代你转发给 Gemini 官方接口。

> 为什么不能用「静态网页」中转？静态网页（如纯 HTML/JS）的请求仍从**你的浏览器本机**发出，直连 Google 一样被墙。只有 Worker 这类**服务端代理**才能借 Cloudflare 服务器访问 Google。所以你部署的是 Worker，不是普通网页。

---

## 一、前置条件

- 一个**已接入 Cloudflare 的域名**（DNS 托管在 Cloudflare，且是橙云代理状态）
- 一个 Gemini API Key（aistudio.google.com/apikey，免费创建）

---

## 二、部署步骤（全程网页操作，无需装任何软件）

### 1. 创建 Worker
1. 登录 Cloudflare 控制台 → 左侧 **Workers & Pages**
2. 点 **Create** → **Create Worker** → 输入名称（如 `gemini-api-relay`）→ 点 **Deploy**
3. 部署完成后点 **Edit code**，进入代码编辑页

### 2. 粘贴中转代码
1. 全选删除编辑器里的默认代码
2. 打开 `gemini-api-relay/worker.js`，全选复制，粘贴进去
3. 点右上角 **Deploy**（保存并部署）

### 3. 配置密钥（推荐，二选一）
在 Worker 详情页 → **Settings** → **Variables and Secrets** → **Add**：

| 类型 | 名称 | 值 |
|---|---|---|
| Secret | `GEMINI_API_KEY` | 你的 Gemini API Key（形如 AIza...） |
| Secret | `RELAY_TOKEN` | 你自己设的强口令（用于防滥用，如 `Gh2026#relay`） |

> 两种模式任选：
> - **模式 A（推荐）**：配置 `GEMINI_API_KEY` + `RELAY_TOKEN`。插件里 API Key 可留空，填「中转令牌」即可；你的 Gemini Key 只存在你自己的 Cloudflare 账号里。
> - **模式 B（透传）**：都不配置。插件里照常填 Gemini API Key，由 Worker 原样转发。

### 4. 绑定你的域名
1. Worker 详情页 → **Settings** → **Domains & Routes** → **Add** → **Custom Domain**
2. 输入你想用的子域名，如 `api.你的域名.com` → 点 **Activate**
3. Cloudflare 会自动创建 DNS 记录（CNAME），**无需手动改 DNS**

### 5. 测试中转是否通
在电脑终端执行（把地址和令牌换成你的）：

```bash
curl -X POST https://api.huanghaigong.dpdns.org/v1beta/models/gemini-3.6-flash:generateContent \
  -H "Content-Type: application/json" \
  -H "x-relay-token: Gh2026#relay" \
  -d '{"contents":[{"role":"user","parts":[{"text":"ping，只回复 pong"}]}],"generationConfig":{"maxOutputTokens":256}}'
```

返回 `pong` 即成功。

---

## 三、插件配置（只需改两处）

打开插件「设置」→ 模型接口配置：

| 项目 | 直连模式（需代理） | 中转模式（免代理） |
|---|---|---|
| 接口地址 Base URL | `https://generativelanguage.googleapis.com/v1beta` | `https://api.你的域名.com/v1beta` |
| API Key | 填 Gemini Key | 模式 A：留空；模式 B：照常填 |
| 中转令牌 | 留空 | 模式 A：填 RELAY_TOKEN；模式 B：留空 |

保存后点「测试连接」，显示连接成功即可。

> 插件版本需 ≥ 1.3.0 才支持「中转令牌」输入框。

---

## 四、安全与配额

- **令牌作用**：没有 `x-relay-token` 的人无法调用你的 Worker，防止陌生人蹭你的免费配额。
- **免费额度**：Cloudflare Workers 免费版每天 10 万次请求，个人填简历绰绰有余。
- **隐私**：简历内容经你**自己的域名**转发给 Google，中间不经过任何第三方；传输全程 HTTPS。
- **Key 存放**：模式 A 下 Gemini Key 只存在 Cloudflare 环境变量（加密存储），插件本地不保存 Key。

---

## 五、常见问题

| 现象 | 原因与处理 |
|---|---|
| 返回 404 | 路径不是 `/v1beta/` 开头；确认插件 Base URL 以 `/v1beta` 结尾 |
| 返回 401 | `x-relay-token` 与 `RELAY_TOKEN` 不一致；或未在插件里填令牌 |
| 返回 400「缺少 x-goog-api-key」 | 模式 A 忘了在 Worker 配 `GEMINI_API_KEY`，或模式 B 插件里没填 API Key |
| 返回 502 | Worker 到 Google 失败：多为 Key 无效，或临时网络抖动，稍后再试 |
| 返回 503 | Gemini 官方模型高峰过载（插件已自动重试 3 次），稍后重试即可 |
| 绑定域名失败 | 确认该域名在 Cloudflare 是橙云（代理）状态；子域名没被其他记录占用 |

---

## 六、备用：用 wrangler CLI 部署（可选）

不想用网页操作也可以命令行部署：

```bash
npm install -g wrangler
cd gemini-api-relay
wrangler login
wrangler secret put GEMINI_API_KEY   # 粘贴你的 Key
wrangler secret put RELAY_TOKEN      # 粘贴你的令牌
wrangler deploy
wrangler routes add api.你的域名.com/v1beta/* --zone-id 你的zoneid
```
