# ---Gemini-api-Smart-web-resume-application-plugin---supports-Gemini-s-API
这是一个支持chrome内核浏览器的插件，它的作用是智能填写网络建立申请，接入Gemini的免费api进行各大网站的简历申请的识别填写，可以在文本中提前写好信息进行自动填写
/
This is a plugin that supports Chrome-based browsers. Its function is to smartly fill out online application forms, using Gemini's free API to 
recognize and fill in resumes for various websites. You can even pre-write your information in the text for automatic filling.

> 你可以提前把个人信息写进文本，剩下的交给它。

**版本选型一览**

| 版本 | 适用人群 | 是否需要代理 | 是否需要自己部署 |
| :--- | :--- | :--- | :--- |
| `smart-autofill-deepseek` | 已有 DeepSeek API | ❌ 不需要 | ❌ 装插件填 Key 即用 |
| `smart-autofill-gemini`（直连） | 已有代理 / 海外网络 | ✅ 需要 | ❌ 装插件填 Gemini Key |
| `smart-autofill-gemini`（中转） | 无代理、想免费用 Gemini | ❌ 不需要 | ✅ 需部署 Cloudflare Worker |

---

## 目录

- [工作原理](#工作原理)
- [一、前置条件](#一前置条件)
- [二、部署步骤](#二部署步骤全程网页操作无需安装任何软件)
- [三、插件配置](#三插件配置只需改两处)
- [四、安全与配额](#四安全与配额)
- [五、常见问题](#五常见问题)
- [六、备用：wrangler CLI 部署](#六备用用-wrangler-cli-部署可选)
- [七、Gemini 免费文本模型与额度](#七gemini-免费文本模型与额度)

---

## 工作原理

插件通过**你自己的域名**访问 Gemini，本机不再需要开代理。请求先打到 Cloudflare 边缘服务器（全球节点，可直连 Google），再由 Worker 代你转发给 Gemini 官方接口。

```
浏览器插件 ──HTTPS──> 你的域名 (Cloudflare Worker) ──> Google Gemini API
                              ↑
                    边缘节点代发请求，本机无需代理
```

> ⚠️ **为什么不能用「静态网页」中转？**
> 静态网页（纯 HTML/JS）的请求仍是从**你的浏览器本机**发出的，直连 Google 一样会被阻断。只有 Worker 这类**服务端代理**，才能借 Cloudflare 的服务器访问 Google。所以你部署的是 Worker，而不是普通网页。

---

## 一、前置条件

- ✅ 一个**已接入 Cloudflare 的域名**（DNS 托管在 Cloudflare，且处于橙云代理状态）
- ✅ 一个 Gemini API Key（在 [aistudio.google.com/apikey](https://aistudio.google.com/apikey) 免费创建）

---

## 二、部署步骤（全程网页操作，无需安装任何软件）

### 1️⃣ 创建 Worker

1. 登录 Cloudflare 控制台 → 左侧 **Workers & Pages**
2. 点 **Create** → **Create Worker** → 输入名称（如 `gemini-api-relay`）→ 点 **Deploy**
3. 部署完成后点 **Edit code**，进入代码编辑页

### 2️⃣ 粘贴中转代码

1. 全选删除编辑器里的默认代码
2. 打开 `gemini-api-relay/worker.js`，全选复制，粘贴进去
3. 点右上角 **Deploy**（保存并部署）

### 3️⃣ 配置密钥（推荐，二选一）

在 Worker 详情页 → **Settings** → **Variables and Secrets** → **Add**：

| 类型 | 名称 | 值 |
| :--- | :--- | :--- |
| Secret | `GEMINI_API_KEY` | 你的 Gemini API Key（形如 `AIza...`） |
| Secret | `RELAY_TOKEN` | 你自己设的强口令（用于防滥用，如 `Gh2026#relay`） |

两种模式任选其一：

- **模式 A（推荐）**：配置 `GEMINI_API_KEY` + `RELAY_TOKEN`。插件里 API Key 可留空，只填「中转令牌」；你的 Gemini Key 只存在你自己的 Cloudflare 账号里。
- **模式 B（透传）**：两者都不配置。插件里照常填 Gemini API Key，由 Worker 原样转发。

### 4️⃣ 绑定你的域名

1. Worker 详情页 → **Settings** → **Domains & Routes** → **Add** → **Custom Domain**
2. 输入你想用的子域名，如 `api.example.com` → 点 **Activate**
3. Cloudflare 会自动创建 DNS 记录（CNAME），**无需手动改 DNS**

### 5️⃣ 测试中转是否通

在电脑终端执行（把地址和令牌换成你自己的）：

```bash
curl -X POST https://api.example.com/v1beta/models/gemini-3.6-flash:generateContent \
  -H "Content-Type: application/json" \
  -H "x-relay-token: Gh2026#relay" \
  -d '{"contents":[{"role":"user","parts":[{"text":"ping，只回复 pong"}]}],"generationConfig":{"maxOutputTokens":256}}'
```

返回 `pong` 即成功 ✅

---

## 三、插件配置（只需改两处）

打开插件「设置」→ 模型接口配置：

| 项目 | 直连模式（需代理） | 中转模式（免代理） |
| :--- | :--- | :--- |
| 接口地址 Base URL | `https://generativelanguage.googleapis.com/v1beta` | `https://你的域名/v1beta` |
| API Key | 填 Gemini Key | 模式 A：留空；模式 B：照常填 |
| 中转令牌 | 留空 | 模式 A：填 `RELAY_TOKEN`；模式 B：留空 |

保存后点「测试连接」，显示连接成功即可。

> 💡 插件版本需 **≥ 1.3.0** 才支持「中转令牌」输入框。

---

## 四、安全与配额

- **令牌作用**：没有 `x-relay-token` 的人无法调用你的 Worker，防止陌生人蹭你的免费配额。
- **免费额度**：Cloudflare Workers 免费版每天 10 万次请求，个人填简历绰绰有余。
- **隐私**：简历内容经你**自己的域名**转发给 Google，中间不经过任何第三方；传输全程 HTTPS。
- **Key 存放**：模式 A 下 Gemini Key 只存在 Cloudflare 环境变量（加密存储），插件本地不保存 Key。

---

## 五、常见问题

| 现象 | 原因与处理 |
| :--- | :--- |
| 返回 404 | 路径不是 `/v1beta/` 开头；确认插件 Base URL 以 `/v1beta` 结尾 |
| 返回 401 | `x-relay-token` 与 `RELAY_TOKEN` 不一致；或未在插件里填令牌 |
| 返回 400「缺少 x-goog-api-key」 | 模式 A 忘了在 Worker 配 `GEMINI_API_KEY`，或模式 B 插件里没填 API Key |
| 返回 502 | Worker 到 Google 失败：多为 Key 无效，或临时网络抖动，稍后再试 |
| 返回 503 | Gemini 官方模型高峰过载（插件已自动重试 3 次），稍后重试即可 |
| 绑定域名失败 | 确认该域名在 Cloudflare 是橙云（代理）状态；子域名没被其他记录占用 |

---

## 六、备用：用 wrangler CLI 部署（可选）

不想用网页操作，也可以命令行部署：

```bash
npm install -g wrangler
cd gemini-api-relay
wrangler login
wrangler secret put GEMINI_API_KEY   # 粘贴你的 Key
wrangler secret put RELAY_TOKEN      # 粘贴你的令牌
wrangler deploy
wrangler routes add api.你的域名.com/v1beta/* --zone-id 你的zoneid
```

---

## 七、Gemini 免费文本模型与额度

以下为 **Google AI Studio 免费层（Free Tier）** 下仍具备可用额度的**文本模型**，按每日可用量从高到低排列。

| 模型 ID | RPM<br>次/分钟 | TPM<br>token/分钟 | RPD<br>次/天 | 上下文 | 说明 |
| :--- | :---: | :---: | :---: | :---: | :--- |
| `gemini-3.5-flash-lite` | 15 | 250K | **500** | 1M | 🥇 免费层首选，额度最高、并发最宽松 |
| `gemini-3.1-flash-lite` | 15 | 250K | **500** | 1M | 🥈 与上者同额度，可作备选 |
| `gemini-2.5-flash-lite` | 10 | 250K | 20 | 1M | 老版本 Flash-Lite，额度偏紧 |
| `gemini-3.8-flash` | 5 | 250K | 20 | 1M | 最新版 Flash，能力强但免费额度低 |
| `gemini-3.7-flash` | 5 | 250K | 20 | 1M | 同上 |
| `gemini-3.6-flash` | 5 | 250K | 20 | 1M | 本 README 示例所用模型 |
| `gemini-3.5-flash` | 5 | 250K | 20 | 1M | 同上 |
| `gemini-3-flash` | 5 | 250K | 20 | 1M | 同上 |
| `gemini-2.5-flash` | 5 | 250K | 20 | 1M | 老版本 Flash |

### 📌 关于这张表的几点提醒

- **Pro 系列已不免费**：自 2026 年 4 月起，`gemini-2.5-pro`、`gemini-3-pro` 等 Pro 模型在免费层的额度为 **0**，必须绑定结算账号才能调用。
- **非文本模型同样为 0**：Veo 视频、Lyria 音乐、Nano Banana 等图像/音视频生成模型，免费层均无可用额度。
- **别被 RPM 迷惑**：真正卡住你的是 **RPD（每日请求数）**。标准 Flash 每天只有 20 次，填几份简历就会耗尽；而 Flash-Lite 有 500 次，相差 25 倍。**强烈建议把插件默认模型改成 `gemini-3.5-flash-lite`**。
- **额度算在项目上，不是算在 Key 上**：同一项目里再申请几组 API Key，总额度也不会变多。
- **数字会随时变动**：Google 会不定期下调免费额度且不另行通知，上表为 **2026 年 9 月**实测值。准确数字请以 **AI Studio → 左侧 Rate Limit → 打开 All models** 页面实时显示为准。
- **免费层的代价**：免费层的输入与输出可能被 Google 用于改进模型；付费层不会。若介意简历等敏感信息，请升级到 Tier 1 或改用本地/第三方模型。

> 触发 429 时先看错误体里是哪一项超限：RPM 超限等 60 秒即可重试，TPM 超限需拆分请求或换更小的模型，RPD 超限则要等到**太平洋时间午夜**重置。
