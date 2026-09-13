import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { exchangeIamGrant, refreshIamToken } from "../src/services/api/auth.ts";

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
}

test("password grant preserves the IAM incorrect-password message", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: null,
        message: "password is incorrect",
        upstreamStatus: 400,
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );

  await assert.rejects(
    exchangeIamGrant({
      grant_type: "password",
      username: "someone@example.test",
      password: "wrong-password",
    }),
    { message: "password is incorrect" },
  );
});

test("token exchange preserves the IAM application-access error", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: null,
        message: "You are not allowed to access this application, please contact the Item Support team or the business BA",
        upstreamStatus: 400,
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );

  await assert.rejects(
    exchangeIamGrant({ grant_type: "password" }),
    { message: "You are not allowed to access this application, please contact the Item Support team or the business BA" },
  );
});

test("password grant does not expose other IAM errors", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ data: null, message: "account is locked" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );

  await assert.rejects(
    exchangeIamGrant({ grant_type: "password" }),
    { message: "Token exchange failed" },
  );
});

test("password grant uses a generic fallback when IAM returns no message", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: null }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });

  await assert.rejects(
    exchangeIamGrant({ grant_type: "password" }),
    { message: "Token exchange failed" },
  );
});

test("refresh grant exchanges a refresh token", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  let request: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    request = init;
    return new Response(JSON.stringify({ data: { access_token: "new-access-token" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await assert.doesNotReject(refreshIamToken("refresh-token"));
  assert.deepEqual(JSON.parse(String(request?.body)), {
    grant_type: "refresh_token",
    refresh_token: "refresh-token",
  });
});

test("tenant switch proxies the authenticated IAM user and target tenant", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname.endsWith("/user-info")) {
      return new Response(JSON.stringify({
        success: true,
        data: {
          id: "iam-user",
          userName: "test-user",
          email: "test@example.test",
          companyCode: "SBFH",
          grantedAppCodes: ["knowledge_fabric"],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname.endsWith("/users/iam-user/tenants")) {
      return new Response(JSON.stringify({ success: true, data: ["SBFH", "LT"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname.endsWith("/company/list-by-codes")) {
      return new Response(JSON.stringify({
        success: true,
        data: [
          { code: "SBFH", name: "Unis Transportation LLC" },
          { code: "LT", name: "Unis, LLC" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname.endsWith("/users/iam-user/tenants/LT/switch")) {
      return new Response(JSON.stringify({ success: true, data: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected IAM request: ${url}`);
  };

  const [{ default: express }, { authRouter }] = await Promise.all([
    import("express"),
    import("../server/auth/routes.ts"),
  ]);
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  const server = http.createServer(app);
  const baseUrl = await listen(server);
  context.after(() => close(server));

  const response = await originalFetch(`${baseUrl}/api/auth/tenants/LT/switch`, {
    method: "PUT",
    headers: { authorization: "Bearer current-access-token" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { tenant_id: "LT" } });
  const switchCall = calls.find((call) => call.url.pathname.endsWith("/users/iam-user/tenants/LT/switch"));
  assert.equal(switchCall?.init?.method, "PUT");
  assert.deepEqual(switchCall?.init?.headers, {
    authorization: "Bearer current-access-token",
    accept: "application/json",
  });

  const meResponse = await originalFetch(`${baseUrl}/api/auth/me`, {
    headers: { authorization: "Bearer current-access-token" },
  });
  assert.equal(meResponse.status, 200);
  const me = await meResponse.json() as { data?: { granted_app_codes?: string[] } };
  assert.deepEqual(me.data?.granted_app_codes, ["knowledge_fabric"]);
});
