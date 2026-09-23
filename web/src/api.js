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
 * 流式跟踪任务日志；连接被掐断时自动轮询补齐到终态。
 * @param {string} id
 * @param {{ log: (msg: string) => void, status: (st: string, error?: string) => void, end: (st: string) => void }} h
 */
export async function streamJob(id, h) {
  let terminal = false;
  try {
    const res = await fetch(`/api/jobs/${id}/stream`, { method: "POST", headers: apiHeaders() });
    if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const part of parts) {
        const line = part.split("\n").find(l => l.startsWith("data: "));
        if (!line) continue;
        const evt = JSON.parse(line.slice(6));
        if (evt.type === "log") h.log(evt.line.msg ?? String(evt.line));
        else if (evt.type === "status") h.status(evt.status, evt.error);
        else if (evt.type === "end") { terminal = true; h.end(evt.status); }
      }
    }
  } catch (e) {
    h.log(`[stream error] ${e.message}`);
  }
  if (terminal) return;
  // 兜底轮询
  let seen = 0;
  for (;;) {
    let run;
    try { run = await api(`/api/jobs/${id}`); } catch { return; }
    if (!run) return;
    for (; seen < (run.logLines || []).length; seen++) h.log(run.logLines[seen].msg);
    if (run.status === "ok" || run.status === "failed") {
      h.status(run.status, run.error);
      h.end(run.status);
      return;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}
