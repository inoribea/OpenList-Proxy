// src/const.js
// Environment variables will be injected by Cloudflare Worker runtime
// These will be set during the fetch function execution
let ADDRESS, TOKEN, WORKER_ADDRESS, DISABLE_SIGN;

// Function to initialize constants from environment variables
function initConstants(env) {
  // OpenList 后端服务器地址 (不要包含尾随斜杠)
  // OpenList backend server address (do not include trailing slash)
  ADDRESS = env.ADDRESS || "YOUR_ADDRESS";
  // OpenList 服务器的 API 访问令牌 (密钥)
  // API access token (secret key) for OpenList server
  TOKEN = env.TOKEN || "YOUR_TOKEN";
  // Cloudflare Worker 的完整地址
  // Full address of your Cloudflare Worker
  WORKER_ADDRESS = env.WORKER_ADDRESS || "YOUR_WORKER_ADDRESS";
  // 是否禁用签名验证 (推荐设置为 false)
  // Whether to disable signature verification (recommended to set as false)
  // 隐私警告：关闭签名会造成文件可被任何知晓路径的人获取
  // Privacy Warning: Disabling signature allows files to be accessed by anyone who knows the path.
  DISABLE_SIGN =
    env.DISABLE_SIGN === "true" || env.DISABLE_SIGN === true || false;
}

// Privacy Warning: Disabling signature allows files to be accessed by anyone who knows the path.
// 隐私警告：关闭签名会造成文件可被任何知晓路径的人获取

// src/verify.js
/**
 * Verifies a signed string with expiration check.
 * @param {string} data - Original data.
 * @param {string} _sign - Signed string.
 * @returns {Promise<string>} Error message if invalid, empty string if valid.
 */
var verify = async (data, _sign) => {
  // If signature verification is disabled, return pass directly
  if (DISABLE_SIGN) {
    return "";
  }

  const signSlice = _sign.split(":");
  if (!signSlice[signSlice.length - 1]) {
    return "expire missing";
  }
  const expire = parseInt(signSlice[signSlice.length - 1]);
  if (isNaN(expire)) {
    return "expire invalid";
  }
  if (expire < Date.now() / 1e3 && expire > 0) {
    return "expire expired";
  }
  const right = await hmacSha256Sign(data, expire);
  if (_sign !== right) {
    return "sign mismatch";
  }
  return "";
};

/**
 * Generates an HMAC-SHA256 signature with expiration.
 * @param {string} data - The data to sign.
 * @param {number} expire - Expiry timestamp (in seconds).
 * @returns {Promise<string>} The signed string.
 */
var hmacSha256Sign = async (data, expire) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(TOKEN),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  const buf = await crypto.subtle.sign(
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    key,
    new TextEncoder().encode(`${data}:${expire}`)
  );
  return (
    btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_") +
    ":" +
    expire
  );
};

// src/handleDownload.js
/**
 * Handles download requests with signature verification and CORS.
 * @param {Request} request - The incoming fetch request.
 * @returns {Promise<Response>} A proper file or error response.
 */
async function handleDownload(request) {
  const origin = request.headers.get("origin") ?? "*";
  const url = new URL(request.url);
  const path = decodeURIComponent(url.pathname);

  // If signature verification is not disabled, perform signature verification
  if (!DISABLE_SIGN) {
    const sign = url.searchParams.get("sign") ?? "";
    const verifyResult = await verify(path, sign);
    if (verifyResult !== "") {
      const resp2 = new Response(
        JSON.stringify({
          code: 401,
          message: verifyResult,
        }),
        {
          headers: {
            "content-type": "application/json;charset=UTF-8",
            "Access-Control-Allow-Origin": origin,
          },
        }
      );
      return resp2;
    }
  }

  let resp = await fetch(`${ADDRESS}/api/fs/link`, {
    method: "POST",
    headers: {
      "content-type": "application/json;charset=UTF-8",
      Authorization: TOKEN,
    },
    body: JSON.stringify({
      path,
    }),
  });
  let res = await resp.json();
  if (res.code !== 200) {
    return new Response(JSON.stringify(res));
  }
  request = new Request(res.data.url, request);
  if (res.data.header) {
    for (const k in res.data.header) {
      for (const v of res.data.header[k]) {
        request.headers.set(k, v);
      }
    }
  }
  let response = await fetch(request);
  while (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location");
    if (location) {
      if (location.startsWith(`${WORKER_ADDRESS}/`)) {
        request = new Request(location, request);
        return await handleRequest(request);
      } else {
        request = new Request(location, request);
        response = await fetch(request);
      }
    } else {
      break;
    }
  }
  response = new Response(response.body, response);
  response.headers.delete("set-cookie");
  response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.append("Vary", "Origin");
  return response;
}

// src/handleOptions.js
/**
 * Handles preflight CORS (OPTIONS) requests.
 * @param {Request} request - The incoming OPTIONS request.
 * @returns {Response} Response with CORS headers.
 */
function handleOptions(request) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
  let headers = request.headers;
  if (
    headers.get("Origin") !== null &&
    headers.get("Access-Control-Request-Method") !== null
  ) {
    let respHeaders = {
      ...corsHeaders,
      "Access-Control-Allow-Headers":
        request.headers.get("Access-Control-Request-Headers") || "",
    };
    return new Response(null, {
      headers: respHeaders,
    });
  } else {
    return new Response(null, {
      headers: {
        Allow: "GET, HEAD, OPTIONS",
      },
    });
  }
}

// src/handleRequest.js
/**
 * Main request handler that routes based on HTTP method.
 * @param {Request} request - The incoming HTTP request.
 * @returns {Promise<Response>} A valid response.
 */
async function handleRequest(request) {
  if (request.method === "OPTIONS") {
    return handleOptions(request);
  }
  return await handleDownload(request);
}

// src/index.js
/**
 * Cloudflare Worker entry point.
 * @param {Request} request - The incoming request.
 * @param {any} env - Environment bindings.
 * @param {ExecutionContext} ctx - Execution context.
 * @returns {Promise<Response>} Response from the handler.
 */
var src_default = {
  async fetch(request, env, ctx) {
    // Initialize constants from environment variables
    initConstants(env);
    return await handleRequest(request);
  },
};
export { src_default as default };
