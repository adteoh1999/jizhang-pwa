// 登录流程状态机：欢迎 → 邮箱（＋邀请码）→ 6 位数验证码 →（Telegram 模式：确认连接）→ 登录成功。不碰 DOM，画面由 js/ui/login.js 订阅后画。
// Telegram 模式（3b-8）：验证成功后 session 先留在记忆体，按「连接」且 tg-link bind 成功，才把 session、lastUserId、tgId 一次写入；
// 失败就作废 session、不清本地资料。initData 剩不到 120 秒就不送验证码、不验证（免得验证码白烧），交给 onInitStale。
// 规则：三个动作（发送、重发、验证）进行中再调一次直接忽略；busy 写明是哪个动作（'send' | 'resend' | 'verify'），一律在 finally 复位。
// error / notice 各带序号（errorSeq / noticeSeq）：同一句再出现序号也会变，画面才知道要重新朗读、重新聚焦。
import {
  normalizeEmailInput, cleanCode, OTP_TTL_MS, RESEND_MS,
  loadPending, savePending, clearPending, loadLastUserId,
} from './auth.js';
import { initDataLeft, TG_BIND_MAX_SEC } from './telegram.js';

const EXPIRED = '验证码已过期，请重新发送';
const UNEXPECTED = '出了点问题，请稍后再试';
const RESEND_SEC = RESEND_MS / 1000;
// 哪些错误要指向哪个栏位（聚焦、标示无效）
const FIELD_OF = {
  '请输入正确的邮箱': 'email',
  '邮箱格式不对': 'email',
  '需要有效的邀请码': 'invite',
  '这个邮箱还没注册，请填邀请码': 'invite',
};
// 改动哪些栏位会清掉这句错误（没列的：只有改 errorField 那一栏才清）
// 「还没注册」虽然聚焦邀请码，但也可能是邮箱打错：改邮箱也清
const CLEARED_BY = {
  '这个邮箱还没注册，请填邀请码': ['email', 'invite'],
};
const warn = (step) => (e) => console.warn(`[login] ${step} 失败：${e && e.name ? e.name : '未知'}`);
const clampRetry = (sec) => Math.max(0, Math.min(RESEND_SEC, sec));
const TG_MIN_LEFT_SEC = 120;   // 少于这么多秒就不送验证码、不验证
const TG_LINK_MIN_SEC = 5;     // 按「连接」时至少要剩这么多秒

/**
 * api：{ registerEmail(email, invite), requestOtp(email), verifyOtp(email, code, nowMs), discardSession?(session) }（已绑好 fetch）
 * confirmReset({txCount})：换账号、本地还有没上传的记录时问（导出 CSV 后清除）→ Promise<boolean>
 * onReset()：换账号清除成功后（通知其他分页）
 * telegram：null（PWA）或 { tgId, label, authDate, bindDeadline, link(session) → tgLink 的回传, status(session) → tgLink status 的回传,
 *   onInitStale(), onCancelUncertain(linked: true | null) }
 */
export function createLoginFlow({ api, store, now = () => Date.now(), onSignedIn, confirmReset = async () => true, onReset = () => {}, telegram = null }) {
  const state = {
    ready: false, step: 'welcome', email: '', code: '', busy: false,
    error: '', errorField: null, errorSeq: 0, notice: '', noticeSeq: 0, sentAt: null,
    linkLabel: '', linkEmail: '',
  };
  const listeners = new Set();
  let lastFailedCode = '';
  let touched = false;        // start() 读完之前用户已经动过 → 不套用读到的结果
  let pendingUsed = false;    // 这组验证码已被服务器用掉（登录资料没存好时）：同邮箱不能走「直接进验证码页」捷径
  let lastSend = null;        // {email, at}：这个流程最近一次送出 requestOtp（送出前就记；R1-11）
  let linkSession = null;     // Telegram：验证成功、等按「连接」的 session（还没写入）
  let linkSwitching = false;
  let linkUncertain = false;  // 按过「连接」但结果不明（超时、5xx）：服务器可能已经连好了

  const discard = (s) => {
    if (s && api.discardSession) Promise.resolve().then(() => api.discardSession(s)).catch(warn('discardSession'));
  };
  // initData 还剩几秒：有服务器算的 bindDeadline 就用它（不靠手机时钟），没有才用 auth_date
  const tgLeft = () => {
    if (!telegram) return Infinity;
    if (Number.isFinite(telegram.bindDeadline)) return (telegram.bindDeadline - now()) / 1000;
    return initDataLeft(telegram.authDate, now(), TG_BIND_MAX_SEC);
  };
  const callStale = () => { try { telegram.onInitStale(); } catch (e) { warn('onInitStale')(e); } };
  // 剩不到 TG_MIN_LEFT_SEC → 交给 onInitStale、回 true（呼叫端什么都不送）
  const tgTooLate = () => {
    if (!telegram || tgLeft() >= TG_MIN_LEFT_SEC) return false;
    callStale();
    return true;
  };
  const sendOtp = (email) => { lastSend = { email, at: now() }; return api.requestOtp(email); };

  const emit = () => {
    const snap = { ...state };
    for (const fn of [...listeners]) {
      try { fn(snap); } catch (e) { console.error(e); }
    }
  };
  const set = (patch) => { Object.assign(state, patch); emit(); };
  // 只改 state、不 emit（在 guarded 里，最后 finally 一次画）
  const setError = (msg) => {
    state.error = msg || '';
    state.errorField = msg ? (FIELD_OF[msg] || null) : null;
    if (msg) state.errorSeq += 1;
  };
  const setNotice = (msg) => {
    state.notice = msg || '';
    if (msg) state.noticeSeq += 1;
  };

  async function guarded(kind, fn) {
    if (state.busy || state.step === 'done') return;
    state.busy = kind;
    setError('');
    emit();
    try {
      await fn();
    } catch (e) {
      warn('流程')(e);
      setError(UNEXPECTED);
    } finally {
      set({ busy: false });
    }
  }

  function enterCode(email, sentAt, notice = '') {
    state.email = email;
    state.sentAt = sentAt;
    state.code = '';
    setNotice(notice);
    state.step = 'code';
    lastFailedCode = '';
    pendingUsed = false;
    savePending(store, { email, sentAt, tgId: telegram ? telegram.tgId : undefined }).catch(warn('savePending')); // 写不进去也照样进验证码页（信已寄出）
  }

  const flow = {
    get state() { return { ...state }; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    async start() {
      if (tgTooLate()) { set({ ready: true }); return; }
      let p = null;
      try { p = await loadPending(store, now()); } catch (e) { warn('loadPending')(e); }
      if (touched) { set({ ready: true }); return; }
      if (p && telegram && p.tgId !== telegram.tgId) {
        // 别的 Telegram（同一台手机换了账号）要的验证码：不显示那个邮箱
        clearPending(store).catch(warn('clearPending'));
        set({ ready: true, step: 'welcome' });
        return;
      }
      if (p && !p.expired) {
        state.sentAt = p.sentAt;
        set({ ready: true, step: 'code', email: p.email, code: '' });
      } else if (p) {
        clearPending(store).catch(warn('clearPending'));
        setNotice(EXPIRED);
        set({ ready: true, step: 'email', email: p.email, sentAt: null });
      } else {
        set({ ready: true, step: 'welcome' });
      }
    },

    goEmail() {
      if (state.busy) return;
      touched = true;
      if (tgTooLate()) return;
      setError('');
      setNotice('');
      set({ step: 'email' });
    },

    back() {
      if (state.busy) return;
      touched = true;
      setError('');
      setNotice('');
      if (state.step === 'code') set({ step: 'email', code: '' }); // pending 保留
      else if (state.step === 'email') set({ step: 'welcome' });
      else if (state.step === 'link') flow.cancelLink();
    },

    /** 回到前景、或送出验证码前调：在验证码页而且已满 10 分钟 → 回邮箱页。回 true 表示已过期。 */
    checkExpiry() {
      if (state.busy === 'verify') return false; // 验证中（含换账号对话框开着）：码已被服务器接受，过期没意义
      if (state.step !== 'code' || state.sentAt == null || now() - state.sentAt < OTP_TTL_MS) return false;
      clearPending(store).catch(warn('clearPending'));
      setError('');
      setNotice(EXPIRED);
      set({ step: 'email', code: '', sentAt: null });
      return true;
    },

    /** 用户改动某个栏位（'email' | 'invite'）：错误跟这个栏位有关就清掉；网络错等没有栏位的错误保留。没有错误时不 emit。 */
    editField(field) {
      if (!state.error) return;
      const fields = CLEARED_BY[state.error] || (state.errorField ? [state.errorField] : []);
      if (!fields.includes(field)) return;
      setError('');
      emit();
    },

    resendLeft(nowMs = now()) {
      if (state.sentAt == null) return 0;
      const left = Math.ceil((state.sentAt + RESEND_MS - nowMs) / 1000);
      return clampRetry(left);
    },

    submitEmail(rawEmail, invite) {
      if (state.busy || state.step === 'done') return Promise.resolve();
      touched = true;
      if (tgTooLate()) return Promise.resolve();
      const email = normalizeEmailInput(rawEmail);
      if (!email) { setNotice(''); setError('请输入正确的邮箱'); emit(); return Promise.resolve(); }
      return guarded('send', async () => {
        setNotice('');
        let pending = null;
        try { pending = await loadPending(store, now()); } catch (e) { warn('loadPending')(e); }
        if (pending && telegram && pending.tgId !== telegram.tgId) pending = null;
        if (pending && !pending.expired && pending.email === email && !pendingUsed) { enterCode(email, pending.sentAt); return; }

        const reg = await api.registerEmail(email, invite);
        if (!reg.ok) { state.email = email; setError(reg.message); return; }
        const sentBefore = (pending && !pending.expired && pending.email === email)
          || (lastSend && lastSend.email === email && now() - lastSend.at < RESEND_MS);
        const otp = await sendOtp(email);
        if (otp.ok) { enterCode(email, now()); return; }
        // 60 秒内刚寄过（可能上一次超时但其实寄出了）：直接去输入验证码。
        // 只有本机真的送过才这样说（R1-11：Telegram 的 generate_link 也会占用 60 秒限制，但不寄信）
        if (Number.isFinite(otp.retrySec) && !pendingUsed && sentBefore) {
          const sentAt = pending && pending.email === email ? pending.sentAt : now() - (RESEND_MS - clampRetry(otp.retrySec) * 1000);
          enterCode(email, sentAt, '验证码刚才已寄出');
          return;
        }
        state.email = email;
        setError(otp.message);
      });
    },

    resend() {
      if (state.step !== 'code' || flow.resendLeft() > 0) return Promise.resolve();
      if (tgTooLate()) return Promise.resolve();
      return guarded('resend', async () => {
        const otp = await sendOtp(state.email);
        if (otp.ok) { enterCode(state.email, now(), '已重新发送'); return; }
        if (Number.isFinite(otp.retrySec)) state.sentAt = now() - (RESEND_MS - clampRetry(otp.retrySec) * 1000);
        setError(otp.message);
      });
    },

    /** 输入框每次变化都调；满 6 位自动送出（不重送刚被判定错误的那一组）。 */
    inputCode(raw) {
      const code = cleanCode(raw);
      if (code !== state.code) {
        state.code = code;
        if (code) setError('');
        emit();
      }
      if (code.length === 6 && code !== lastFailedCode && !state.busy) return flow.submitCode();
      return Promise.resolve();
    },

    /** 送出验证码。登录成功后（guarded 之外）才叫 onSignedIn：它丢的错会原样往外丢，不会被当成「出了点问题」。 */
    async submitCode() {
      if (state.busy || state.step !== 'code') return;
      if (tgTooLate()) return; // pending 保留：重新打开后会直接回到输入验证码
      if (flow.checkExpiry()) return;
      const code = state.code;
      if (code.length !== 6) { setError('请输入 6 位数验证码'); emit(); return; }
      let signedIn = null;
      await guarded('verify', async () => {
        const r = await api.verifyOtp(state.email, code, now());
        if (!r.ok) {
          // 只有服务器明确说码不对（400/401/403）才清空；网络错、429、5xx 保留，让用户按一次重试
          if (r.status === 400 || r.status === 401 || r.status === 403) {
            lastFailedCode = code;
            state.code = '';
          }
          setError(r.message);
          return;
        }
        const s = r.session;
        const notSaved = (step) => (e) => {
          warn(step)(e);
          pendingUsed = true;
          clearPending(store).catch(warn('clearPending'));
          Object.assign(state, { step: 'email', code: '', sentAt: null });
          setError('登录资料没存好，请重新发送验证码');
        };
        // 读不到「上一个账号 / 账本主人」不能当成没有：宁可不登录，也不让新账号认领别人的账
        let last = null;
        let owner = null;
        try {
          await store.init(); // 快取可能比资料库旧（别的分页记过账、或已清除换账号）：重新载入再判断（审核 M-1）
          last = await loadLastUserId(store);
          owner = (await store.getMeta('owner_user_id')) || null;
        } catch (e) {
          notSaved('loadOwner')(e);
          if (api.discardSession) Promise.resolve().then(() => api.discardSession(s)).catch(warn('discardSession'));
          return;
        }
        const prevOwner = owner || last; // 本地账本（可能）的主人
        // 换账号（spec §7.7、审核 M5）：清掉这台设备的账本（同一次写入连 session 一起写）。
        // 还有没上传的记录才问：已归属 → 待上传 + 无法同步；还没归属（没开始同步）→ 整本都没上传
        const switching = !!prevOwner && prevOwner !== s.user_id;
        if (switching) {
          const info = store.unsyncedInfo({ all: !owner });
          let go = true;
          if (info.any) {
            // 码已被服务器用掉：对话框开着时 App 被关掉，重开不该停在验证码页（审核 S-4）
            pendingUsed = true;
            await clearPending(store).catch(warn('clearPending'));
            go = await confirmReset({ txCount: info.txCount });
          }
          if (!go) {
            pendingUsed = true; // 这组验证码已被服务器用掉
            if (api.discardSession) Promise.resolve().then(() => api.discardSession(s)).catch(warn('discardSession')); // 尽力作废（审核 S-5）
            clearPending(store).catch(warn('clearPending'));
            Object.assign(state, { step: 'welcome', code: '', sentAt: null });
            setNotice('');
            return;
          }
        }
        if (telegram) {
          // 先不写入：按「连接」且 bind 成功才写（这组验证码已用掉）
          pendingUsed = true;
          await clearPending(store).catch(warn('clearPending'));
          linkSession = s;
          linkSwitching = switching;
          Object.assign(state, { step: 'link', code: '', sentAt: null, linkEmail: s.email || state.email, linkLabel: telegram.label || '' });
          setNotice('');
          return;
        }
        // session、lastUserId（换账号时连清除与新 owner）同一次写入：要嘛全有要嘛全无
        const meta = { session: s, lastUserId: s.user_id };
        try {
          if (switching) await store.resetForAccount(s.user_id, { meta });
          else await store.setMetas(meta);
        } catch (e) {
          notSaved(switching ? 'resetForAccount' : 'saveSession')(e);
          discard(s); // 没存起来的 session：尽力作废
          return;
        }
        if (switching) { try { onReset(); } catch (e) { warn('onReset')(e); } }
        await clearPending(store).catch(warn('clearPending'));
        state.step = 'done';
        signedIn = s;
      });
      if (signedIn) onSignedIn(signedIn);
    },

    /** Telegram：确认连接。bind 成功才把 session、lastUserId、tgId 一次写入。 */
    async confirmLink() {
      if (!telegram || state.busy || state.step !== 'link' || !linkSession) return;
      const s = linkSession;
      if (tgLeft() <= TG_LINK_MIN_SEC) { // 已经来不及：不送 bind（服务器也会拒绝）
        linkSession = null;
        discard(s);
        callStale();
        return;
      }
      let signedIn = null;
      let stale = false;
      await guarded('link', async () => {
        const r = await telegram.link(s);
        if (r && r.ok) {
          const meta = { session: s, lastUserId: s.user_id, tgId: telegram.tgId };
          try {
            if (linkSwitching) await store.resetForAccount(s.user_id, { meta });
            else await store.setMetas(meta);
          } catch (e) {
            warn(linkSwitching ? 'resetForAccount' : 'saveSession')(e);
            linkSession = null;
            discard(s);
            Object.assign(state, { step: 'email' });
            setError('登录资料没存好，请关掉后重新打开'); // 服务器已连接：重新打开就会直接进入
            return;
          }
          if (linkSwitching) { try { onReset(); } catch (e) { warn('onReset')(e); } }
          linkSession = null;
          state.step = 'done';
          signedIn = s;
          return;
        }
        if (r && r.code === 'init_stale') { linkSession = null; discard(s); stale = true; return; }
        if (r && r.retry) { linkUncertain = true; setError(r.error || UNEXPECTED); return; } // 留在连接步骤，可以再按（不必重要验证码）
        linkSession = null;
        discard(s);
        state.step = 'email';
        setError((r && r.error) || UNEXPECTED);
      });
      if (stale) callStale();
      if (signedIn) onSignedIn(signedIn);
    },

    /**
     * Telegram：不连接。作废这次的 session、回欢迎页，本地资料不动。
     * 之前按「连接」结果不明（超时、5xx）：服务器可能已经连好了 → 先问状态（用户 2026-11-26 选），
     * 连上了或问不到 → onCancelUncertain(true | null) 让画面说明「可以到 PWA 设置里解除」。
     */
    async cancelLink() {
      if (state.busy || state.step !== 'link') return;
      const s = linkSession;
      linkSession = null;
      let linked = false;
      if (linkUncertain && s && telegram.status) {
        state.busy = 'cancel';
        emit();
        try {
          const r = await telegram.status(s);
          linked = r && r.ok ? r.data.linked === true : null;
        } catch (e) {
          warn('status')(e);
          linked = null;
        }
        state.busy = false;
      }
      linkUncertain = false;
      discard(s);
      setError('');
      setNotice('');
      set({ step: 'welcome', linkLabel: '', linkEmail: '' });
      if (linked !== false) { try { telegram.onCancelUncertain(linked); } catch (e) { warn('onCancelUncertain')(e); } }
    },
  };
  return flow;
}
