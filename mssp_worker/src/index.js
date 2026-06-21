const FEED_PATH = "/feed";
const PRODUCTION_ORIGIN = "https://peykc.github.io";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export default {
  async fetch(request) {
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname !== FEED_PATH || requestUrl.search) {
      return response("Not found", 404);
    }

    const origin = request.headers.get("Origin") || "";
    if (!isAllowedOrigin(origin)) {
      return response("Origin not allowed", 403);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, true),
      });
    }

    if (request.method !== "POST") {
      return response("Method not allowed", 405, origin, {
        Allow: "POST, OPTIONS",
      });
    }

    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
      return response("Content-Type must be application/json", 415, origin);
    }

    let payload;
    try {
      const body = await request.text();
      if (body.length > 4096) return response("Request body too large", 413, origin);
      payload = JSON.parse(body);
    } catch {
      return response("Invalid JSON", 400, origin);
    }

    const feedUrl = parsePatreonFeedUrl(payload?.url);
    if (!feedUrl) {
      return response("Invalid Patreon RSS URL", 400, origin);
    }

    let upstream;
    try {
      upstream = await fetch(feedUrl.href, {
        method: "GET",
        headers: {
          Accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
        },
        redirect: "follow",
        cf: {
          cacheEverything: false,
          cacheTtl: 0,
        },
      });
    } catch {
      return response("Patreon RSS request failed", 502, origin);
    }

    if (!upstream.ok) {
      return response("Patreon RSS request failed", 502, origin);
    }

    const contentType = upstream.headers.get("Content-Type") || "";
    if (!contentType.toLowerCase().includes("xml")) {
      return response("Patreon returned a non-XML response", 502, origin);
    }

    const headers = corsHeaders(origin);
    headers.set("Content-Type", contentType);
    return new Response(upstream.body, {
      status: 200,
      headers,
    });
  },
};

function isAllowedOrigin(origin) {
  if (origin === PRODUCTION_ORIGIN) return true;

  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.origin === origin
      && !url.username
      && !url.password
      && LOCAL_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

function parsePatreonFeedUrl(value) {
  if (typeof value !== "string") return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.hostname !== "www.patreon.com") return null;
    if (url.port || url.username || url.password) return null;
    if (!url.pathname.startsWith("/rss/") || url.pathname.length <= "/rss/".length) return null;
    return url;
  } catch {
    return null;
  }
}

function corsHeaders(origin, preflight = false) {
  const headers = new Headers({
    "Access-Control-Allow-Origin": origin,
    "Cache-Control": "private, no-store",
    Vary: "Origin",
    "X-Content-Type-Options": "nosniff",
  });

  if (preflight) {
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
  }

  return headers;
}

function response(body, status, origin = "", extraHeaders = {}) {
  const headers = isAllowedOrigin(origin)
    ? corsHeaders(origin)
    : new Headers({
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
  headers.set("Content-Type", "text/plain; charset=utf-8");
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  return new Response(body, { status, headers });
}
