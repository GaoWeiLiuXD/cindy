/**
 * CallbackListener(xAI OAuth loopback 回调)回归单测 —— issue #491。
 *
 * xAI 新版 consent 页(accounts.x.ai)授权后不再 302 重定向,而是页面 JS 跨源
 * fetch http://127.0.0.1:56121/callback 投递 code。回归点:
 *   - CORS/PNA preflight(OPTIONS)必须 204 放行且不得终止登录流 —— 修复前它落进
 *     缺 code 分支直接 reject,整个登录被 preflight 杀死;
 *   - 回执必须带 CORS 头(白名单限 xAI auth 域),否则 consent 页 fetch 读不到结果;
 *   - 无 code 无 error 的杂请求不得终止等待中的登录;
 *   - 首个终态结果落定后,重试回调不得覆盖 pendingRes / 登录结果。
 */

import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
  app: {
    getPath: vi.fn(() => '/tmp/xdt-maker-test'),
    getAppPath: vi.fn(() => '/tmp/xdt-maker-test/app'),
    isPackaged: false,
  },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
}));

import { CallbackListener, xaiCallbackCorsHeaders } from '../grok-oauth-login.js';

const PORT = 56121;
const XAI_ORIGIN = 'https://accounts.x.ai';

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** 用 node:http 直发请求(fetch 不允许自定义 Origin 这类受管头)。 */
function send(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      // agent:false —— 每请求独立连接。全局 agent 的 keep-alive 会把上一个用例
      // 已关闭 server 的死 socket 复用给下一个用例,产生假 ECONNRESET。
      { host: '127.0.0.1', port: PORT, method, path, headers, agent: false },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString('utf-8')));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** 断言 promise 在 wait 毫秒内保持 pending(登录流未被终止)。 */
async function expectStillPending(p: Promise<unknown>, wait = 50): Promise<void> {
  const outcome = await Promise.race([
    p.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise<string>((r) => setTimeout(() => r('pending'), wait)),
  ]);
  expect(outcome).toBe('pending');
}

describe('xaiCallbackCorsHeaders', () => {
  it('白名单 origin(accounts.x.ai / auth.x.ai)返回完整 CORS + PNA 头', () => {
    for (const origin of ['https://accounts.x.ai', 'https://auth.x.ai']) {
      const h = xaiCallbackCorsHeaders(origin);
      expect(h['Access-Control-Allow-Origin']).toBe(origin);
      expect(h['Access-Control-Allow-Methods']).toBe('GET, OPTIONS');
      expect(h['Access-Control-Allow-Private-Network']).toBe('true');
      expect(h.Vary).toBe('Origin');
    }
  });

  it('非白名单 / 缺失 origin 不放行', () => {
    expect(xaiCallbackCorsHeaders('https://evil.example')).toEqual({});
    expect(xaiCallbackCorsHeaders('http://accounts.x.ai')).toEqual({});
    expect(xaiCallbackCorsHeaders(undefined)).toEqual({});
  });
});

describe('CallbackListener(xAI loopback 回调)', () => {
  let listener: CallbackListener;

  beforeEach(async () => {
    listener = new CallbackListener();
    await listener.start();
  });

  afterEach(() => {
    listener.close();
  });

  it('OPTIONS preflight 回 204 + CORS/PNA 头,且不终止登录流', async () => {
    const codePromise = listener.waitForCode('state-1');
    codePromise.catch(() => undefined);

    const res = await send('OPTIONS', '/callback', {
      origin: XAI_ORIGIN,
      'access-control-request-method': 'GET',
      'access-control-request-private-network': 'true',
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(XAI_ORIGIN);
    expect(res.headers['access-control-allow-private-network']).toBe('true');

    // 修复前:preflight 落进缺 code 分支,登录流被 reject 杀死。
    await expectStillPending(codePromise);

    // preflight 后正式 GET 仍能完成登录。
    const getPromise = send('GET', '/callback?code=abc123&state=state-1', {
      origin: XAI_ORIGIN,
    });
    await expect(codePromise).resolves.toBe('abc123');
    listener.succeed();
    const getRes = await getPromise;
    expect(getRes.status).toBe(200);
    expect(getRes.headers['access-control-allow-origin']).toBe(XAI_ORIGIN);
  });

  it('无 code 无 error 的杂请求回 400 但登录继续等待', async () => {
    const codePromise = listener.waitForCode('state-2');
    codePromise.catch(() => undefined);

    const res = await send('GET', '/callback');
    expect(res.status).toBe(400);
    await expectStillPending(codePromise);

    const getPromise = send('GET', '/callback?code=xyz&state=state-2');
    await expect(codePromise).resolves.toBe('xyz');
    listener.succeed();
    await getPromise;
  });

  it('带 error 参数的回调终止登录并透出 error_description', async () => {
    const codePromise = listener.waitForCode('state-3');
    // 与生产 runGrokOAuthLogin 同模式预挂 no-op catch:reject 可能先于下方
    // rejects 断言挂载,避免被记成 unhandled rejection。
    codePromise.catch(() => undefined);
    const res = await send(
      'GET',
      '/callback?error=access_denied&error_description=user%20denied',
      { origin: XAI_ORIGIN },
    );
    expect(res.status).toBe(400);
    expect(res.headers['access-control-allow-origin']).toBe(XAI_ORIGIN);
    await expect(codePromise).rejects.toThrow('No authorization code received');
  });

  it('state 不匹配终止登录', async () => {
    const codePromise = listener.waitForCode('expected-state');
    codePromise.catch(() => undefined);
    const res = await send('GET', '/callback?code=abc&state=wrong-state');
    expect(res.status).toBe(400);
    await expect(codePromise).rejects.toThrow('Invalid state parameter');
  });

  it('登录结果落定后重试回调直接回执,不覆盖首个响应', async () => {
    const codePromise = listener.waitForCode('state-5');

    const firstGet = send('GET', '/callback?code=first&state=state-5', {
      origin: XAI_ORIGIN,
    });
    await expect(codePromise).resolves.toBe('first');

    // token 交换进行中(首个响应仍被 hold),页面重试 fetch —— 立即回执,不悬空。
    const retry = await send('GET', '/callback?code=first&state=state-5', {
      origin: XAI_ORIGIN,
    });
    expect(retry.status).toBe(200);
    expect(retry.headers['access-control-allow-origin']).toBe(XAI_ORIGIN);

    // 首个响应仍由 succeed() 正常收口。
    listener.succeed();
    const first = await firstGet;
    expect(first.status).toBe(200);
    expect(first.body).toContain('html');
  });

  it('非白名单 origin 的响应不带 CORS 放行头', async () => {
    const codePromise = listener.waitForCode('state-6');
    const getPromise = send('GET', '/callback?code=ok&state=state-6', {
      origin: 'https://evil.example',
    });
    await expect(codePromise).resolves.toBe('ok');
    listener.succeed();
    const res = await getPromise;
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('回调端口被占用时 start() 报可读错误', async () => {
    const blocker = new CallbackListener();
    // beforeEach 已占 56121,新实例 start 应失败。
    await expect(blocker.start()).rejects.toThrow('56121');
    blocker.close();
  });
});
