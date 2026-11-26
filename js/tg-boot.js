// Telegram Mini App 启动（3b-9）：决定要直接进 App、换登录、清掉别人的账本、还是显示挡画面。
// 纯函数（tgBootStep、tgAfterLogin）＋可注入的流程（runTgBoot、runTgCheck），都不碰 DOM。
// 身份一律以服务器为准：initDataUnsafe 的 tgId 只用来比对「本机账本是不是这个 Telegram 的」。
import { loadSession, loadLastUserId } from './auth.js';

export const TG_RECHECK_MS = 30 * 60_000; // 回前景最多 30 分钟检查一次（initData 过 24 小时后 check 会回 init_stale → skip）
export const TG_RETRY_CHECK_MS = 60_000;  // 上次 skip（网络错、等锁超时）：1 分钟后就可以再试
const LOADING_AFTER_MS = 1000;

export const TG_TEXT = Object.freeze({
  netTitle: '需要网络',
  netMessage: '连上网络后再试一次。',
  serverTitle: '暂时无法登录，请稍后再试',
  serverMessage: '服务器暂时有问题。',
  limitedTitle: '请 1 分钟后再试',
  limitedMessage: '刚才尝试太多次了。',
  invalidTitle: '无法确认 Telegram 身份',
  invalidMessage: '请关掉后，从 @adjizhangbot 的选单按钮重新打开。',
  // 没有身份资料（实测 7：Telegram 内建浏览器点网址就是这样）；那里 close() 没作用，所以不放按钮
  noInitTitle: '请从选单按钮打开',
  noInitMessage: '这个链接要在 Telegram 里从 @adjizhangbot 的「记账」按钮打开。请按左上角 ✕ 关掉。',
  notSavedTitle: '登录资料没存好，请再试一次',
  notSavedMessage: '这台设备的资料没有改动。',
  retry: '再试一次',
  close: '关闭',
  foreignTitle: '这台设备上有另一个账号的账本',
  foreignMessage: (label) => `继续会用${label ? ` Telegram ${label} ` : '这个 Telegram '}登录，并清除这本账（还没上传的记录会消失）。不认识这个名字就按「关闭」。`,
  foreignUnlinkedMessage: '继续会清除这本账（还没上传的记录会消失），之后要用邮箱登录。不认识这本账就按「关闭」。',
  foreignClear: '清除并继续',
  // 按了「关闭」但 close() 没作用（例如 Telegram 内建浏览器）：不要留白屏
  closedTitle: '请关掉这个页面',
  closedMessage: '下次从 @adjizhangbot 打开时会再问一次。',
  signedInToast: (label, email) => `已用 Telegram ${label ? `${label} ` : ''}登录 · ${email}`,
});

/** 不问服务器就能直接进 App：session 在、没有失效、而且是这个 Telegram 连接时存的。 */
export function tgBootStep({ session, tgId, envTgId }) {
  return session && !session.invalid && tgId === envTgId ? 'reuse' : 'login';
}

/**
 * 问过 tg-login 之后怎么办。local = { session, tgId, prevUser, owned }；prevUser 是账本主人（owner ?? lastUserId ?? session.user_id）。
 * 回 { do, exportOk }：exportOk 只在本机账本是这个 Telegram 的时候为 true（别人的账本不给导出，r1-S3）。
 */
export function tgAfterLogin({ local, envTgId, result }) {
  const { session, tgId, prevUser, owned } = local;
  const exportOk = tgId === envTgId;
  const foreignLocal = !!(session || owned) && tgId !== envTgId;
  let act;
  if (result && result.ok && result.status === 'linked') {
    if (prevUser === result.session.user_id) act = 'adopt';
    else if (!prevUser && !owned) act = 'fresh';
    else if (foreignLocal) act = 'foreign';
    else act = 'switch';
  } else if (result && result.ok && result.status === 'unlinked') {
    if (foreignLocal) act = 'foreign';
    else if (session || owned) act = 'gone'; // 本机有这个 Telegram 的账本，但服务器说没连接了 → 已解除连接流程（r2-M2-3）
    else act = 'login';
  } else if (result && result.ok) {
    act = result.status; // stale
  } else {
    act = (result && result.kind) || 'server';
  }
  return { do: act, exportOk };
}

export const shouldRecheck = (lastMs, nowMs) => nowMs - lastMs >= TG_RECHECK_MS;

/** 现在该不该再检查连接：从没检查 → 是；上次 skip → 1 分钟后；ok／renewed → 30 分钟后。 */
export function checkDue({ lastAt, lastResult }, nowMs) {
  if (!lastResult) return true;
  return nowMs - lastAt >= (lastResult === 'skip' ? TG_RETRY_CHECK_MS : TG_RECHECK_MS);
}

/**
 * Telegram 启动。deps：
 *   store, env（detectTelegram 的 telegram 结果）, online(), tgLogin(initData) → tg-api.tgLogin 的结果,
 *   logoutServer(session), choice(opts), askReset(unsyncedInfo) → boolean, wipe() → boolean,
 *   showScreen({title, message, buttonLabel, onClick}), showLoading(), mountShell(session),
 *   mountLogin(unlinkedResult), closeMiniApp(), toast(text), announceReset(), runTgGone(), loadingAfterMs?, reload?
 * 回 'shell' | 'login' | 'screen' | 'closed' | 'gone'。
 */
export async function runTgBoot(deps) {
  const { store, env } = deps;
  const reload = deps.reload || (() => globalThis.location && globalThis.location.reload());
  const screen = (title, message, buttonLabel, onClick) => { deps.showScreen({ title, message, buttonLabel, onClick }); return 'screen'; };
  const retryScreen = (title, message) => screen(title, message, TG_TEXT.retry, reload);
  const closeScreen = () => screen(TG_TEXT.invalidTitle, TG_TEXT.invalidMessage, TG_TEXT.close, () => deps.closeMiniApp());
  // 用户选了关闭：先画挡画面再 close()（close() 没作用时不是白屏）
  const closeNow = () => {
    screen(TG_TEXT.closedTitle, TG_TEXT.closedMessage, TG_TEXT.close, () => deps.closeMiniApp());
    deps.closeMiniApp();
    return 'closed';
  };
  const discard = (s) => { try { if (s) deps.logoutServer(s); } catch { /* 尽力 */ } };
  const notSaved = (s) => { discard(s); return retryScreen(TG_TEXT.notSavedTitle, TG_TEXT.notSavedMessage); };

  const session = await loadSession(store);
  const tgId = (await store.getMeta('tgId')) ?? null;
  if (tgBootStep({ session, tgId, envTgId: env.tgId }) === 'reuse') { deps.mountShell(session); return 'shell'; }
  if (!deps.online()) return retryScreen(TG_TEXT.netTitle, TG_TEXT.netMessage);

  // 等太久（超过 1 秒）才显示「正在载入…」，免得一闪
  const timer = setTimeout(() => { try { deps.showLoading(); } catch { /* 忽略 */ } }, deps.loadingAfterMs ?? LOADING_AFTER_MS);
  let result;
  try { result = await deps.tgLogin(env.initData); } finally { clearTimeout(timer); }

  const fresh = result && result.status === 'linked' ? result.session : null;
  try {
    return await afterLogin(deps, { session, tgId, result, fresh, screen, retryScreen, closeScreen, closeNow, discard, notSaved });
  } catch (e) {
    discard(fresh); // 后面出意外：刚换来的 session 没人用，先作废
    throw e;
  }
}

async function afterLogin(deps, { session, tgId, result, fresh, retryScreen, closeScreen, closeNow, discard, notSaved }) {
  const { store, env } = deps;
  const owner = (await store.getMeta('owner_user_id')) || null;
  const last = await loadLastUserId(store);
  const prevUser = owner ?? last ?? (session ? session.user_id : null);
  const owned = store.hasOwnedData();
  const { do: act } = tgAfterLogin({ local: { session, tgId, prevUser, owned }, envTgId: env.tgId, result });
  const meta = fresh ? { session: fresh, tgId: env.tgId, lastUserId: fresh.user_id } : null;
  const oldValid = session && !session.invalid && (!fresh || session.access_token !== fresh.access_token) ? session : null;
  const toastIn = () => deps.toast(TG_TEXT.signedInToast(result.label, fresh.email));

  switch (act) {
    case 'net': return retryScreen(TG_TEXT.netTitle, TG_TEXT.netMessage);
    case 'server': return retryScreen(TG_TEXT.serverTitle, TG_TEXT.serverMessage);
    case 'limited': return retryScreen(TG_TEXT.limitedTitle, TG_TEXT.limitedMessage);
    case 'invalid':
    case 'stale': return closeScreen();
    case 'login': deps.mountLogin(result); return 'login';
    case 'gone': await deps.runTgGone(); return 'gone';

    case 'adopt':
    case 'fresh': {
      try { await store.setMetas(meta); } catch { return notSaved(fresh); }
      discard(oldValid);
      deps.mountShell(fresh);
      if (act === 'fresh') toastIn(); // 第一次用 Telegram 身份进入：明显提示（Review Focus 2②）
      return 'shell';
    }

    case 'switch': {
      const info = store.unsyncedInfo({ all: !owner });
      if (info.any && !(await deps.askReset(info))) {
        discard(fresh);
        return closeNow();
      }
      try { await store.resetForAccount(fresh.user_id, { meta }); } catch { return notSaved(fresh); }
      deps.announceReset();
      discard(oldValid);
      deps.mountShell(fresh);
      return 'shell';
    }

    case 'foreign': {
      // 别的 Telegram 留下的账本：不提供导出（那不是这个人的资料），只能清除或关闭
      const v = await deps.choice({
        title: TG_TEXT.foreignTitle,
        message: fresh ? TG_TEXT.foreignMessage(result.label) : TG_TEXT.foreignUnlinkedMessage,
        // 安全选项在左（同 confirmDialog）
        buttons: [
          { label: TG_TEXT.close, value: 'close', focus: true },
          { label: TG_TEXT.foreignClear, destructive: true, value: 'clear' },
        ],
      });
      if (v !== 'clear') {
        discard(fresh);
        return closeNow();
      }
      if (!(await deps.wipe())) return notSaved(fresh);
      deps.announceReset();
      discard(oldValid);
      if (!fresh) { deps.mountLogin(result); return 'login'; }
      try { await store.setMetas(meta); } catch { return notSaved(fresh); }
      deps.mountShell(fresh);
      toastIn();
      return 'shell';
    }
  }
  return retryScreen(TG_TEXT.serverTitle, TG_TEXT.serverMessage);
}

/**
 * App 开着时确认这个 Telegram 还连着这个账号（启动后一次、回前景最多 30 分钟一次）。deps：
 *   env, userId, getSession() → getValidSession 的结果, tgLink(token, 'check', {initData}), tgLogin(initData),
 *   saveSession(session) → true 才算存了（replaceSessionIfSameUser）, discard(session)
 * 回 'ok' | 'gone' | 'renewed' | 'skip'。网络错、时效过期、身份资料坏掉都 skip（不清本机，Review Focus 4）。
 */
export async function runTgCheck(deps) {
  const g = await deps.getSession();
  if (g && g.retry) return 'skip';
  if (g && g.session) {
    const r = await deps.tgLink(g.session.access_token, 'check', { initData: deps.env.initData });
    if (r.ok) {
      if (r.data && r.data.linked === true) return 'ok';
      if (r.data && r.data.linked === false) return 'gone';
      return 'skip';
    }
    if (r.status !== 401) return 'skip'; // init_stale、tg_invalid、网络错、5xx
  }
  // session 失效、或 token 被拒：凭 initData 问 tg-login（r1-M2：token 过期 1 小时以上也能判断）
  const l = await deps.tgLogin(deps.env.initData);
  if (!l || !l.ok) return 'skip';
  if (l.status === 'unlinked') return 'gone';
  if (l.status !== 'linked') return 'skip';
  if (l.session.user_id !== deps.userId) { deps.discard(l.session); return 'gone'; }
  if ((await deps.saveSession(l.session)) !== true) { deps.discard(l.session); return 'skip'; }
  return 'renewed';
}
