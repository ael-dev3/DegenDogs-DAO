import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createClient, Errors } from "@farcaster/quick-auth";

const client = createClient();
const publicDir = path.resolve(process.cwd(), "public");
const port = Number(process.env.PORT || 3000);
const appDomain = process.env.APP_DOMAIN || "";
const corsOrigin = process.env.CORS_ORIGIN || "";
const neynarApiKey = process.env.NEYNAR_API_KEY || "";
const neynarApiBase = process.env.NEYNAR_API_BASE || "https://api.neynar.com";

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

function setCors(res: http.ServerResponse, req: http.IncomingMessage) {
  const origin = corsOrigin || (req.headers.origin ?? "");
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) {
      throw new Error("Body too large");
    }
  }
  return raw;
}

async function fetchNeynarUser(fid: number) {
  if (!neynarApiKey) {
    return null;
  }

  const url = new URL(`${neynarApiBase}/v2/farcaster/user/bulk`);
  url.searchParams.set("fids", String(fid));

  const res = await fetch(url.toString(), {
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": neynarApiKey,
    },
  });

  if (!res.ok) {
    throw new Error(`Neynar HTTP ${res.status}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const result = data.result as Record<string, unknown> | undefined;
  const users = Array.isArray(data.users)
    ? data.users
    : Array.isArray(result?.users)
      ? result?.users
      : null;
  const user =
    users && users.length > 0
      ? (users[0] as Record<string, unknown>)
      : (data.user as Record<string, unknown> | undefined);

  return user ?? null;
}

async function handleVerify(req: http.IncomingMessage, res: http.ServerResponse) {
  setCors(res, req);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST" && req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  const raw = req.method === "POST" ? await readBody(req) : "";
  let token = "";
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { token?: string };
      token = parsed.token || "";
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }
  }

  if (!token && typeof req.headers.authorization === "string") {
    const auth = req.headers.authorization;
    if (auth.startsWith("Bearer ")) {
      token = auth.slice(7);
    }
  }

  if (!token) {
    sendJson(res, 400, { error: "missing_token" });
    return;
  }

  const forwardedHost =
    req.headers["x-forwarded-host"] ||
    req.headers["x-original-host"] ||
    req.headers["x-forwarded-server"] ||
    "";
  const hostHeader = forwardedHost || req.headers.host || "";
  const hostValue = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  const host = hostValue.split(",")[0]?.trim().split(":")[0] || "";
  const domain = appDomain || host;
  if (!domain) {
    sendJson(res, 500, { error: "missing_domain" });
    return;
  }

  try {
    const payload = await client.verifyJwt({ token, domain });
    const fid =
      typeof payload.sub === "string" ? Number(payload.sub) : payload.sub;
    if (!Number.isFinite(fid)) {
      sendJson(res, 400, { error: "invalid_fid" });
      return;
    }
    let user: Record<string, unknown> | null = null;
    if (neynarApiKey) {
      try {
        user = await fetchNeynarUser(fid);
      } catch (err) {
        console.error("Neynar lookup failed:", err);
      }
    }

    const verifiedSet = new Set<string>();
    const verifiedEth =
      (user?.verified_addresses as { eth_addresses?: string[] } | undefined)
        ?.eth_addresses ?? [];
    const verifications = Array.isArray(user?.verifications)
      ? (user?.verifications as string[])
      : [];
    const custodyAddress =
      typeof user?.custody_address === "string" ? user.custody_address : undefined;

    for (const addr of verifiedEth) {
      verifiedSet.add(addr);
    }
    for (const addr of verifications) {
      verifiedSet.add(addr);
    }
    if (custodyAddress) {
      verifiedSet.add(custodyAddress);
    }
    sendJson(res, 200, {
      fid,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
      username: (user?.username as string | undefined) ?? undefined,
      displayName:
        (user?.display_name as string | undefined) ??
        (user?.displayName as string | undefined) ??
        undefined,
      custodyAddress,
      verifiedEthAddresses: Array.from(verifiedSet),
    });
  } catch (err) {
    if (err instanceof Errors.InvalidTokenError) {
      sendJson(res, 401, { error: "invalid_token" });
      return;
    }
    console.error(err);
    sendJson(res, 500, { error: "verification_failed" });
  }
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
  const filePath = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.resolve(publicDir, `.${filePath}`);
  if (!safePath.startsWith(publicDir)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  try {
    const fileStat = await stat(safePath);
    if (!fileStat.isFile()) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    const data = await readFile(safePath);
    const ext = path.extname(safePath);
    res.statusCode = 200;
    res.setHeader("content-type", mimeTypes[ext] || "application/octet-stream");
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/api/verify") {
    await handleVerify(req, res);
    return;
  }

  await serveStatic(req, res, url.pathname);
});

server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});



