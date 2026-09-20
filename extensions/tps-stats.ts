import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "tps-stats";

let turnStartMs = 0;
let liveTimer: ReturnType<typeof setInterval> | undefined;

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function stopLive() {
  if (liveTimer) {
    clearInterval(liveTimer);
    liveTimer = undefined;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    stopLive();
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
  });

  pi.on("turn_start", async (_event, ctx) => {
    turnStartMs = Date.now();
    stopLive();
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  });

  pi.on("turn_end", async (event, ctx) => {
    const secs = turnStartMs > 0 ? (Date.now() - turnStartMs) / 1000 : 0;
    stopLive();
    if (!ctx.hasUI) return;

    const msg = (event as any).message as any;
    const usage = msg?.usage;
    if (!usage) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    const out = usage.output ?? 0;
    const inp = usage.input ?? 0;
    const cacheR = usage.cacheRead ?? 0;
    const cacheW = usage.cacheWrite ?? 0;
    const total = usage.totalTokens ?? inp + out + cacheR + cacheW;
    const tps = secs > 0 ? out / secs : 0;

    const line =
      `TPS ${tps.toFixed(1)} tok/s, out ${fmtInt(out)}, ` +
      `in ${fmtInt(inp)}, cache r/w ${fmtInt(cacheR)}/${fmtInt(cacheW)}, ` +
      `total ${fmtInt(total)}, ${secs.toFixed(1)}s`;

    ctx.ui.setWidget(WIDGET_KEY, [ctx.ui.theme.fg("dim", line)], { placement: "aboveEditor" });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    stopLive();
    void ctx;
  });
}
