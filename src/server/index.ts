import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createClient, Errors } from "@farcaster/quick-auth";

const client = createClient();
const publicDir = path.resolve(process.cwd(), "public");
const port = Number(process.env.PORT || 3000);
const appDomain = process.env.APP_DOMAIN || "";
const corsOrigin = process.env.CORS_ORIGIN || "";

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
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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

async function handleVerify(req: http.IncomingMessage, res: http.ServerResponse) {
  setCors(res, req);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  const raw = await readBody(req);
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

  const host = req.headers.host ? req.headers.host.split(":")[0] : "";
  const domain = appDomain || host;
  if (!domain) {
    sendJson(res, 500, { error: "missing_domain" });
    return;
  }

  try {
    const payload = await client.verifyJwt({ token, domain });
    sendJson(res, 200, {
      fid: payload.sub,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
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
