// ============================================================
// Cloudflare Worker —— Gemini API 中转（免代理直连）
// ------------------------------------------------------------
// 部署后，把扩展的「接口地址 Base URL」改为：
//   https://你的域名/v1beta
// 其余完全兼容 generateContent 接口，插件无需改代码逻辑。
//
// 环境变量（在 Cloudflare Dashboard -> Worker -> Settings ->
// Variables and Secrets 中配置，均为可选）：
//   GEMINI_API_KEY : 若设置，中转固定使用这个 Key（推荐，此时
//                    插件设置里 API Key 可留空，Key 只存在于
//                    你自己的 Cloudflare 账号里）
//   RELAY_TOKEN    : 若设置，请求必须携带请求头 x-relay-token
//                    且值一致，否则返回 401（防止陌生人滥用
//                    你的 Worker 配额，强烈建议设置）
//
// 两种模式：
//   模式 A（推荐，安全）：配置了 GEMINI_API_KEY + RELAY_TOKEN
//   模式 B（透传）：两者都不配，直接转发插件请求自带的
//                    x-goog-api-key 头
// ============================================================

const UPSTREAM = "https://generativelanguage.googleapis.com";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-goog-api-key, x-relay-token",
  "Access-Control-Max-Age": "86400"
};

// 仅允许代理到 Google 的路径（防止你的域名被当作任意代理）
const ALLOWED_PREFIX = "/v1beta/";

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

export default {
  async fetch(request, env) {
    // 1. CORS 预检（浏览器直连调试时用；扩展本身不受 CORS 限制）
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // 2. 只代理 /v1beta/ 路径
    if (!url.pathname.startsWith(ALLOWED_PREFIX)) {
      return json({ error: { message: "Not Found: 仅支持 /v1beta/ 路径" } }, 404);
    }

    // 3. 令牌鉴权（设置了 RELAY_TOKEN 时强制校验）
    const relayToken = env.RELAY_TOKEN || "";
    const gotToken = request.headers.get("x-relay-token") || "";
    if (relayToken && gotToken !== relayToken) {
      return json({ error: { message: "中转令牌无效（x-relay-token 不匹配）" } }, 401);
    }

    // 4. 组装上游请求头
    const headers = new Headers(request.headers);
    // 去掉 Cloudflare 注入 / 会干扰上游的头
    ["host", "cf-connecting-ip", "x-forwarded-for", "x-real-ip", "cf-ray", "cf-visitor", "cf-ipcountry", "cf-worker", "cf-connecting-asn", "cdn-loop"].forEach(
      (h) => headers.delete(h)
    );

    // 5. 确定 API Key：优先用 Worker 环境变量，否则透传请求自带的
    if (env.GEMINI_API_KEY) {
      headers.set("x-goog-api-key", env.GEMINI_API_KEY);
    } else if (!headers.has("x-goog-api-key")) {
      return json({ error: { message: "缺少 x-goog-api-key，且 Worker 未配置 GEMINI_API_KEY" } }, 400);
    }

    // 6. 转发到 Google 并回传
    const upstreamUrl = UPSTREAM + url.pathname + url.search;
    try {
      const resp = await fetch(upstreamUrl, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body
      });
      const newHeaders = new Headers(resp.headers);
      Object.entries(CORS_HEADERS).forEach(([k, v]) => newHeaders.set(k, v));
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: newHeaders
      });
    } catch (err) {
      return json({ error: { message: "中转请求失败：" + err.message } }, 502);
    }
  }
};
