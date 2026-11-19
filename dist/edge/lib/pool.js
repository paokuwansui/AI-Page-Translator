/* lib/pool.js —— 并发池 + 令牌桶限速 + 批聚合
 * 参考:沉浸式翻译(并发上限 + 令牌桶 7/1250ms)、kiss-translator(TaskPool: 并发/启动间隔/重试;
 *       BatchQueue: 400ms / 20 段 / 10000 字符 / 10 批并发)
 */
'use strict';
(function (global) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 令牌桶:保证 interval 窗口内启动的请求数不超过 limit(平滑限流,避免被封) */
  function createRateLimiter({ limit = 8, interval = 1200 } = {}) {
    let starts = [];
    let lim = limit;
    let win = interval;
    return {
      async acquire() {
        for (;;) {
          const now = Date.now();
          starts = starts.filter((t) => now - t < win);
          if (starts.length < lim) { starts.push(now); return; }
          await sleep(Math.max(20, win - (now - starts[0]) + 5));
        }
      },
      set({ limit: l, interval: i } = {}) {
        if (Number.isFinite(l) && l > 0) lim = Math.floor(l);
        if (Number.isFinite(i) && i > 0) win = i;
      },
      state: () => ({ limit: lim, interval: win, inWindow: starts.length }),
    };
  }

  /**
   * 并发池:并发上限 + 可选限速器 + 指数退避重试。
   * 限流/服务端错误(429/5xx)时自动降档(throttle),而不是把块判死。
   *
   * ⚠️ 不可重入:同一个池里"外层任务 await 内层 pool.run"会在并发打满时自锁
   *   (外层占着槽位等内层,内层排不到槽位)→ 嵌套场景请用另一个池实例
   *   (参见 content.js 的 fbPool 降级池、tests/pool.test.mjs 的反例断言)。
   * ⚠️ 任务函数应当"最终 settle";兜底:jobTimeout>0 时超时的任务会被判失败并释放槽位
   *   (上游另有更短的看门狗,如 Lib.chatStream / Lib.sendMsg 的超时)。
   * ⚠️ 降档可自动回升:throttle 后 recoverAfter 毫秒内不再被限流 → 并发逐级恢复,不必等下一轮翻译。
   */
  function createPool({ concurrency = 12, maxRetry = 2, retryInterval = 1000, limiter = null, onChange = () => {},
                       jobTimeout = 0, recoverAfter = 15000 } = {}) {
    let baseLimit = Math.max(1, Math.floor(concurrency));
    let limit = baseLimit;
    let active = 0;
    let coolUntil = 0;
    let lastThrottleAt = 0;
    let q = [];
    let timer = null;

    /** 超时兜底:防止"永不 settle 的 fn"永久占槽 + idle() 挂死(不可取消,只能放弃等待) */
    const withTimeout = (p, ms) => {
      if (!ms) return p;
      let t = null;
      return Promise.race([
        p,
        new Promise((_, rej) => {
          t = setTimeout(() => {
            const e = new Error('任务超时: ' + ms + 'ms 无响应');
            e.timeout = true;
            rej(e);
          }, ms);
        }),
      ]).finally(() => { if (t) clearTimeout(t); });
    };

    function pump() {
      if (timer) { clearTimeout(timer); timer = null; }
      // 降档恢复:一段时间没再被限流 → 并发逐级回升(一次 429 不该拖慢整轮)
      if (limit < baseLimit && lastThrottleAt && Date.now() - lastThrottleAt >= recoverAfter) {
        limit = Math.min(baseLimit, limit * 2);
        onChange({ limit, status: 'recover' });
      }
      const cool = coolUntil - Date.now();
      if (cool > 0) { timer = setTimeout(pump, cool); return; }
      while (active < limit && q.length) {
        const job = q.shift();
        active++;
        (async () => {
          let attempt = 0;
          let err = null;
          for (;;) {
            try {
              if (limiter) await limiter.acquire();
              const v = await withTimeout(job.fn(attempt), jobTimeout);
              job.resolve(v);
              return;
            } catch (e) {
              err = e;
              attempt++;
              const st = e && e.status;
              const retriable = attempt <= maxRetry && !(e && e.timeout)      // 超时不再重试:只会再等一个超时
                && (st === 429 || st >= 500 || st === 0 || !st);
              if (!retriable) break;
              if (st === 429 || st >= 500) {
                const back = retryInterval * Math.pow(2, attempt - 1) + Math.random() * 300;
                coolUntil = Math.max(coolUntil, Date.now() + Math.min(back, 8000));
              }
              await sleep(Math.min(retryInterval * attempt, 3000));
            }
          }
          job.reject(err);
        })().finally(() => { active--; pump(); });
      }
    }

    return {
      run: (fn) => new Promise((resolve, reject) => { q.push({ fn, resolve, reject }); pump(); }),
      /** 遇到 429/5xx:折半降档 + 冷却(沉浸式/默认限流的做法) */
      throttle: (status) => {
        lastThrottleAt = Date.now();
        limit = Math.max(1, Math.floor(limit / 2));
        coolUntil = Math.max(coolUntil, Date.now() + (status === 429 ? 1200 : 600));
        onChange({ limit, status });
        setTimeout(pump, 30);
      },
      concurrency: () => limit,
      setConcurrency: (n) => { baseLimit = Math.max(1, Math.floor(n)); limit = baseLimit; pump(); },
      baseConcurrency: () => baseLimit,
      pending: () => q.length,
      active: () => active,
      idle: async () => { while (active > 0 || q.length) await sleep(20); },
    };
  }

  /**
   * 批聚合:把大量小段攒成一次请求(减请求数、降首字延迟、避免限流)。
   * flush(items) 必须返回与 items 等长、按序对应的结果数组。
   */
  function createBatcher({ batchInterval = 400, batchSize = 20, batchLength = 8000, flush } = {}) {
    let cur = [], len = 0, timer = null, closed = false;
    const fire = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!cur.length) return;
      const items = cur;
      cur = []; len = 0;
      Promise.resolve()
        .then(() => flush(items))
        .then((res) => {
          items.forEach((it, i) => {
            const v = Array.isArray(res) ? res[i] : undefined;
            it.resolve(v === undefined ? null : v);
          });
        })
        .catch((e) => items.forEach((it) => it.reject(e)));
    };
    return {
      add(item) {
        return new Promise((resolve, reject) => {
          if (closed) { reject(new Error('batcher closed')); return; }
          const t = (item && item.text) || '';
          // 加入前先判断「再加就超长」→ 先把当前批发出去,保证每批 ≤ batchLength(单条超长时独占一批)
          if (cur.length && len + t.length > batchLength) fire();
          cur.push({ ...item, resolve, reject });
          len += t.length;
          if (cur.length >= batchSize) { fire(); return; }
          if (!timer) timer = setTimeout(fire, batchInterval);
        });
      },
      flushNow: fire,
      pending: () => cur.length,
      close: () => { closed = true; fire(); },
    };
  }

  const api = { createPool, createRateLimiter, createBatcher };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LFPool = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
