import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { createClient, Errors } from "@farcaster/quick-auth";

const client = createClient();
const neynarApiKey = process.env.NEYNAR_API_KEY || "";

type Request = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
};

type Response = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => Response;
  json: (body: unknown) => void;
  send: (body?: string) => void;
};

function setCors(req: Request, res: Response) {
  const origin = (req.headers.origin as string | undefined) || "";
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
}

function headerValue(header: string | string[] | undefined) {
  if (!header) {
    return "";
  }
  if (Array.isArray(header)) {
    return header[0] || "";
  }
  return header;
}

function getDomain(req: Request) {
  const forwardedHost =
    headerValue(req.headers["x-forwarded-host"]) ||
    headerValue(req.headers["x-original-host"]) ||
    headerValue(req.headers["x-forwarded-server"]);
  const hostHeader = forwardedHost || headerValue(req.headers.host);
  const hostValue = hostHeader.split(",")[0]?.trim() || "";
  return hostValue.split(":")[0] || "";
}

async function fetchNeynarUser(fid: number) {
  if (!neynarApiKey) {
    return null;
  }

  const url = new URL("https://api.neynar.com/v2/farcaster/user/bulk");
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

function readToken(req: Request) {
  let token = "";
  if (req.method === "POST") {
    if (typeof req.body === "string") {
      try {
        const parsed = JSON.parse(req.body) as { token?: string };
        token = parsed.token || "";
      } catch {
        return "";
      }
    } else if (typeof req.body === "object" && req.body) {
      const parsed = req.body as { token?: string };
      token = parsed.token || "";
    }
  }

  if (!token) {
    const authHeader = headerValue(req.headers.authorization);
    if (authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    }
  }

  return token;
}

export const verify = onRequest(async (req, res) => {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const token = readToken(req);
  if (!token) {
    res.status(400).json({ error: "missing_token" });
    return;
  }

  const domain = getDomain(req);
  if (!domain) {
    res.status(500).json({ error: "missing_domain" });
    return;
  }

  try {
    const payload = await client.verifyJwt({ token, domain });
    const fid =
      typeof payload.sub === "string" ? Number(payload.sub) : payload.sub;
    if (!Number.isFinite(fid)) {
      res.status(400).json({ error: "invalid_fid" });
      return;
    }

    let user: Record<string, unknown> | null = null;
    if (neynarApiKey) {
      try {
        user = await fetchNeynarUser(fid);
      } catch (err) {
        logger.warn("Neynar lookup failed", err);
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
      typeof user?.custody_address === "string"
        ? user.custody_address
        : undefined;

    for (const addr of verifiedEth) {
      verifiedSet.add(addr);
    }
    for (const addr of verifications) {
      verifiedSet.add(addr);
    }
    if (custodyAddress) {
      verifiedSet.add(custodyAddress);
    }

    res.status(200).json({
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
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    logger.error("Verification failed", err);
    res.status(500).json({ error: "verification_failed" });
  }
});
