// 设置页「设定／检查／暂停 Telegram bot」三个按钮的流程（3d；只有站主看得到）。
// 全部依赖注入（测试 tests/tg-admin-actions.test.js 测行为）：
//   getSession() → {session}、api.{setup,status,pause}(accessToken) → {ok, error?, data?}、
//   confirm(opts) → boolean、message({title, message})、toast(text)、onBusy(kind, busy)
// 一次只做一件：进行中（含暂停的确认框开着）再按任何一个都不做事。

export const TG_ADMIN_TEXT = Object.freeze({
  busy: { 'tg-setup': '正在设定…', 'tg-status': '正在检查…', 'tg-pause': '正在暂停…' },
  ok: { 'tg-setup': '已设定 Telegram bot', 'tg-pause': '已暂停 Telegram bot' },
  failTitle: { 'tg-setup': '没能设定 Telegram bot', 'tg-status': '没能检查 Telegram bot', 'tg-pause': '没能暂停 Telegram bot' },
  pauseTitle: '暂停 Telegram bot？',
  pauseMessage: '暂停期间传给 bot 的讯息不会补记。再按「设定 Telegram bot」就恢复。',
  pauseConfirm: '暂停',
  relogin: '请重新登录后再试',
  generic: '暂时无法完成，请稍后再试',
});
const T = TG_ADMIN_TEXT;

const RECENT_ERROR_MS = 10 * 60 * 1000;

/** 「检查 Telegram bot」对话框的文字（纯函数）。时间显示成马来西亚时间 YYYY-MM-DD HH:mm。
 *  webhook 正常但 10 分钟内有错误（例如换了密钥没重按设定）→ 标题提醒（用户决定 9）。 */
export function tgStatusText({ webhook, pending, lastErrorAt, aiUsed24h }, nowMs = Date.now()) {
  let err = '没有';
  if (lastErrorAt) {
    const d = new Date(Date.parse(lastErrorAt) + 8 * 3600 * 1000).toISOString();
    err = `${d.slice(0, 10)} ${d.slice(11, 16)}`;
  }
  return {
    title: webhook !== 'ok' ? '没设好，请按「设定 Telegram bot」'
      : lastErrorAt && nowMs - Date.parse(lastErrorAt) <= RECENT_ERROR_MS ? '已设定，但最近有错误' : '正常',
    message: `待处理讯息：${pending} 则\n最近错误：${err}\n24 小时内 AI 用了：${aiUsed24h === null ? '—' : `${aiUsed24h} 次`}`,
  };
}

const API_OF = { 'tg-setup': 'setup', 'tg-status': 'status', 'tg-pause': 'pause' };

export function createTgAdminActions(deps) {
  let busy = false;

  async function call(kind) {
    deps.onBusy(kind, true);
    try {
      const got = await deps.getSession();
      return got && got.session ? await deps.api[API_OF[kind]](got.session.access_token) : { ok: false, error: T.relogin };
    } catch (e) {
      console.warn(`[settings] Telegram bot 管理出错：${e && e.name ? e.name : '未知'}`);
      return { ok: false, error: T.generic };
    } finally {
      deps.onBusy(kind, false);
    }
  }

  /** 回 'done' | 'fail' | 'cancel' | 'busy' */
  async function click(kind) {
    if (!API_OF[kind]) return 'cancel';
    if (busy) return 'busy';
    busy = true;
    try {
      if (kind === 'tg-pause') {
        const yes = await deps.confirm({ title: T.pauseTitle, message: T.pauseMessage, confirmLabel: T.pauseConfirm, destructive: true });
        if (!yes) return 'cancel';
      }
      const r = await call(kind);
      if (!r.ok) {
        await deps.message({ title: T.failTitle[kind], message: r.error });
        return 'fail';
      }
      if (kind === 'tg-status') await deps.message(tgStatusText(r.data));
      else deps.toast(T.ok[kind]);
      return 'done';
    } finally {
      busy = false;
    }
  }

  return { click };
}
