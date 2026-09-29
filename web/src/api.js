/** API 客户端：token 认证 + JSON + SSE-over-POST 流式日志（含断流轮询兜底）。 */

export function apiHeaders() {
  const t = localStorage.getItem("devops-token") || "";
  return { "Content-Type": "application/json", ...(t ? { "x-devops-token": t } : {}) };
}

export async function api(path, opts = {}) {
  const res = await fetch(path, { headers: apiHeaders(), ...opts });
  if (res.status === 401) throw new Error("token 不正确（右上角填写）");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/**
 * 流式跟踪任务日志；连接被掐断/挂死时自动轮询补齐到终态（按已投递行数续传，不重放）。
 * @param {string} id
 * @param {{ log: (msg: string) => void, status: (st: string, error?: string) => void, node?: (nodeStatus: Record<string,string> | null) => void, nodeInputs?: (nodeInputs: Record<string, Record<string,string>> | null) => void, end: (st: string) => void }} h
 * @param {AbortSignal} [signal] 取消：中断流与轮询（切换跟踪目标时先取消旧流，避免两条流交织写同一日志）
 */
export async function streamJob(id, h, signal) {
  let terminal = false;
  let delivered = 0; // 已投递给 h.log 的行数——轮询兜底从此续传
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(`/api/jobs/${id}/stream`, { method: "POST", headers: apiHeaders(), signal: ac.signal });
    if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      // 心跳 10s 一跳：15s 无数据视为流挂死（代理掐断但不关流），落到轮询兜底
      let idleTimer;
      const timeoutP = new Promise((_, rej) => { idleTimer = setTimeout(() => rej(new Error("stream idle")), 15000); });
      timeoutP.catch(() => {}); // read 先返回时吞掉超时侧的落空拒绝
      let chunk;
      try {
        chunk = await Promise.race([reader.read(), timeoutP]);
      } finally { clearTimeout(idleTimer); }
      const { done, value } = chunk;
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const part of parts) {
        const line = part.split("\n").find(l => l.startsWith("data: "));
        if (!line) continue;
        const evt = JSON.parse(line.slice(6));
        if (evt.type === "log") { delivered++; h.log(evt.line.msg ?? String(evt.line)); }
        else if (evt.type === "status") h.status(evt.status, evt.error);
        else if (evt.type === "node") h.node?.(evt.nodeStatus);
        else if (evt.type === "nodeinputs") h.nodeInputs?.(evt.nodeInputs);
        else if (evt.type === "end") { terminal = true; h.end(evt.status); }
      }
    }
  } catch (e) {
    if (!signal?.aborted) h.log(`[stream error] ${e.message}`);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (terminal || signal?.aborted) return;
  // 兜底轮询（从已投递行数续传）
  let seen = delivered;
  for (;;) {
    if (signal?.aborted) return;
    let run;
    try { run = await api(`/api/jobs/${id}`); } catch { return; }
    if (!run) return;
    for (; seen < (run.logLines || []).length; seen++) h.log(run.logLines[seen].msg);
    h.node?.(run.nodeStatus ?? null);
    h.nodeInputs?.(run.nodeInputs ?? null);
    if (run.status === "ok" || run.status === "failed") {
      h.status(run.status, run.error);
      h.end(run.status);
      return;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}
