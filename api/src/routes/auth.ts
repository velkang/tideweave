import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { hashOpaqueValue, issueChallenge, verifyChallenge } from "../auth";
import { agentIdentity } from "../automation";
import type { AppEnvironment, RouteDeps } from "../env";
import { jsonBody, record } from "../http";

const SESSION_COOKIE = "tideweave_session";

/**
 * Sign-in with a signed message, then the session and agent checks that guard every
 * route registered after this one.
 */
export function registerAuthRoutes(app: Hono<AppEnvironment>, deps: RouteDeps) {
  const { now } = deps;
  app.post("/v1/auth/challenge", async (context) => {
    const body = record(await jsonBody(context));
    const challenge = await issueChallenge(
      context.get("authStore"),
      { address: body.address },
      {
        chainId: 143,
        domain: new URL(context.env.AUTH_URI).host,
        uri: context.env.AUTH_URI,
      },
      { now },
    );
    return context.json(challenge, 201);
  });
  app.post("/v1/auth/verify", async (context) => {
    const body = record(await jsonBody(context));
    const result = await verifyChallenge(
      context.get("authStore"),
      {
        challengeId: body.challengeId,
        message: body.message,
        signature: body.signature,
      },
      { now },
    );
    setCookie(context, SESSION_COOKIE, result.sessionToken, {
      httpOnly: true,
      maxAge: Math.floor((result.sessionExpiresAt - now()) / 1_000),
      path: "/",
      sameSite: "Strict",
      secure: context.env.AUTH_COOKIE_SECURE !== "false",
    });
    return context.json({
      user: result.user,
      sessionExpiresAt: result.sessionExpiresAt,
    });
  });

  app.use("/v1/*", agentIdentity());
  app.use("/v1/me", requireSession(now));
  app.use("/v1/auth/logout", requireSession(now));
  app.use("/v1/wallets/*", requireSession(now));
  app.use("/v1/automation/*", requireSession(now));

  app.get("/v1/me", (context) => context.json({ user: context.get("user") }));
  app.post("/v1/auth/logout", async (context) => {
    await context
      .get("authStore")
      .deleteSession(context.get("sessionTokenHash"));
    deleteCookie(context, SESSION_COOKIE, { path: "/" });
    return context.body(null, 204);
  });
}

function requireSession(now: () => number) {
  return async (
    context: Context<AppEnvironment>,
    next: () => Promise<void>,
  ) => {
    // agentIdentity already set the user for the automation Worker's requests.
    if (context.get("agentRun")) return next();
    const token = getCookie(context, SESSION_COOKIE);
    if (!token) return context.json({ error: "UNAUTHENTICATED" }, 401);

    const tokenHash = await hashOpaqueValue(token);
    const user = await context
      .get("authStore")
      .findSessionUser(tokenHash, now());
    if (!user) return context.json({ error: "UNAUTHENTICATED" }, 401);

    context.set("user", user);
    context.set("sessionTokenHash", tokenHash);
    await next();
  };
}
