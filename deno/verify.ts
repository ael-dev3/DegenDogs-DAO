import { createClient, Errors } from "https://esm.sh/@farcaster/quick-auth@0.0.8?target=deno";

const client = createClient();
const rawAppDomain = Deno.env.get("APP_DOMAIN") || "";
const appDomains = rawAppDomain
  .split(",")
  .map((value) => normalizeDomain(value))
  .filter(Boolean);
const neynarApiKey = Deno.env.get("NEYNAR_API_KEY") || "";
const neynarApiBase = Deno.env.get("NEYNAR_API_BASE") || "https://api.neynar.com";

function corsHeaders(origin: string) {
  return {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "vary": "Origin",
  };
}

function hostFromHeaders(headers: Headers) {
  const forwardedHost =
    headers.get("x-forwarded-host") ||
    headers.get("x-original-host") ||
    headers.get("x-forwarded-server") ||
    "";
  const hostHeader = forwardedHost || headers.get("host") || "";
  const hostValue = hostHeader.split(",")[0]?.trim() || "";
  return hostValue.split(":")[0] || "";
}

function normalizeDomain(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    if (trimmed.includes("://")) {
      return new URL(trimmed).hostname;
    }
  } catch {
    // fall through to string parsing
  }
  const noPath = trimmed.split("/")[0] || "";
  return noPath.split(":")[0] || "";
}

function decodeJwtPayload(token: string) {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  const raw = parts[1] || "";
  if (!raw) {
    return null;
  }
  const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  try {
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readToken(req: Request) {
  let token = "";
  if (req.method === "POST") {
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      try {
        const body = (await req.json()) as { token?: string };
        token = body.token || "";
      } catch {
        token = "";
      }
    } else {
      try {
        const text = await req.text();
        if (text) {
          const body = JSON.parse(text) as { token?: string };
          token = body.token || "";
        }
      } catch {
        token = "";
      }
    }
  }

  if (!token) {
    const auth = req.headers.get("authorization") || "";
    if (auth.startsWith("Bearer ")) {
      token = auth.slice(7);
    }
  }

  return token;
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

Deno.serve(async (req) => {
  try {
    const origin = req.headers.get("origin") || "";
    const originDomain = normalizeDomain(origin);
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname !== "/api/verify") {
      return new Response("Not found", {
        status: 404,
        headers: corsHeaders(origin),
      });
    }

    if (req.method !== "GET" && req.method !== "POST") {
      return new Response(JSON.stringify({ error: "method_not_allowed" }), {
        status: 405,
        headers: {
          ...corsHeaders(origin),
          "content-type": "application/json; charset=utf-8",
        },
      });
    }

    const token = await readToken(req);
    if (!token) {
      return new Response(JSON.stringify({ error: "missing_token" }), {
        status: 400,
        headers: {
          ...corsHeaders(origin),
          "content-type": "application/json; charset=utf-8",
        },
      });
    }

    const hostDomain = hostFromHeaders(req.headers);
    const candidateDomains = appDomains.length
      ? appDomains
      : [originDomain, hostDomain].filter(Boolean);
    const uniqueDomains = Array.from(new Set(candidateDomains));
    if (!uniqueDomains.length) {
      return new Response(
        JSON.stringify({
          error: "missing_domain",
          originDomain,
          hostDomain,
          hint:
            "Set APP_DOMAIN to your Mini App host (no scheme), e.g. degendogs-dao.web.app. Use comma-separated domains to allow web.app + firebaseapp.com.",
        }),
        {
          status: 500,
          headers: {
            ...corsHeaders(origin),
            "content-type": "application/json; charset=utf-8",
          },
        },
      );
    }

    try {
      let payload: Awaited<ReturnType<typeof client.verifyJwt>> | null = null;
      let lastInvalid: Errors.InvalidTokenError | null = null;
      for (const candidate of uniqueDomains) {
        try {
          payload = await client.verifyJwt({ token, domain: candidate });
          break;
        } catch (err) {
          if (err instanceof Errors.InvalidTokenError) {
            lastInvalid = err;
            continue;
          }
          throw err;
        }
      }
      if (!payload) {
        const decoded = decodeJwtPayload(token);
        const tokenAud =
          typeof decoded?.aud === "string"
            ? decoded.aud
            : Array.isArray(decoded?.aud)
              ? decoded.aud.map(String).join(",")
              : undefined;
        const tokenIss =
          typeof decoded?.iss === "string" ? decoded.iss : undefined;
        return new Response(
          JSON.stringify({
            error: "invalid_token",
            attemptedDomains: uniqueDomains,
            originDomain,
            hostDomain,
            appDomains: appDomains.length ? appDomains : undefined,
            tokenAud,
            tokenIss,
            detail: lastInvalid?.message,
            hint:
              "Set APP_DOMAIN to your Mini App host (no scheme), e.g. degendogs-dao.web.app. Use comma-separated domains to allow web.app + firebaseapp.com.",
          }),
          {
            status: 401,
            headers: {
              ...corsHeaders(origin),
              "content-type": "application/json; charset=utf-8",
            },
          },
        );
      }
      const fid =
        typeof payload.sub === "string" ? Number(payload.sub) : payload.sub;
      if (!Number.isFinite(fid)) {
        return new Response(JSON.stringify({ error: "invalid_fid" }), {
          status: 400,
          headers: {
            ...corsHeaders(origin),
            "content-type": "application/json; charset=utf-8",
          },
        });
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

      return new Response(
        JSON.stringify({
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
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders(origin),
            "content-type": "application/json; charset=utf-8",
          },
        },
      );
    } catch (err) {
      console.error("Verification failed:", err);
      return new Response(JSON.stringify({ error: "verification_failed" }), {
        status: 500,
        headers: {
          ...corsHeaders(origin),
          "content-type": "application/json; charset=utf-8",
        },
      });
    }
  } catch (err) {
    console.error("Unhandled request error:", err);
    return new Response(JSON.stringify({ error: "unhandled_error" }), {
      status: 500,
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
    });
  }
});
