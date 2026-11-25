// 登录流程状态机：欢迎 → 邮箱（＋邀请码）→ 6 位数验证码 → 登录成功。不碰 DOM，画面由 js/ui/login.js 订阅后画。
// 规则：三个动作（发送、重发、验证）进行中再调一次直接忽略；busy 写明是哪个动作（'send' | 'resend' | 'verify'），一律在 finally 复位。
// error / notice 各带序号（errorSeq / noticeSeq）：同一句再出现序号也会变，画面才知道要重新朗读、重新聚焦。
import {
  normalizeEmailInput, cleanCode, OTP_TTL_MS, RESEND_MS,
  loadPending, savePending, clearPending, loadLastUserId,
} from './auth.js';

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

/**
 * api：{ registerEmail(email, invite), requestOtp(email), verifyOtp(email, code, nowMs) }（已绑好 fetch）
 * confirmReset({txCount})：换账号、本地还有没上传的记录时问（导出 CSV 后清除）→ Promise<boolean>
 */
export function createLoginFlow({ api, store, now = () => Date.now(), onSignedIn, confirmReset = async () => true }) {
  const state = {
    ready: false, step: 'welcome', email: '', code: '', busy: false,
    error: '', errorField: null, errorSeq: 0, notice: '', noticeSeq: 0, sentAt: null,
  };
  const listeners = new Set();
  let lastFailedCode = '';
  let touched = false;        // start() 读完之前用户已经动过 → 不套用读到的结果
  let pendingUsed = false;    // 这组验证码已被服务器用掉（登录资料没存好时）：同邮箱不能走「直接进验证码页」捷径

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
    savePending(store, { email, sentAt }).catch(warn('savePending')); // 写不进去也照样进验证码页（信已寄出）
  }

  const flow = {
    get state() { return { ...state }; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    async start() {
      let p = null;
      try { p = await loadPending(store, now()); } catch (e) { warn('loadPending')(e); }
      if (touched) { set({ ready: true }); return; }
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
    },

    /** 回到前景、或送出验证码前调：在验证码页而且已满 10 分钟 → 回邮箱页。回 true 表示已过期。 */
    checkExpiry() {
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
      const email = normalizeEmailInput(rawEmail);
      if (!email) { setNotice(''); setError('请输入正确的邮箱'); emit(); return Promise.resolve(); }
      return guarded('send', async () => {
        setNotice('');
        let pending = null;
        try { pending = await loadPending(store, now()); } catch (e) { warn('loadPending')(e); }
        if (pending && !pending.expired && pending.email === email && !pendingUsed) { enterCode(email, pending.sentAt); return; }

        const reg = await api.registerEmail(email, invite);
        if (!reg.ok) { state.email = email; setError(reg.message); return; }
        const otp = await api.requestOtp(email);
        if (otp.ok) { enterCode(email, now()); return; }
        if (Number.isFinite(otp.retrySec) && !pendingUsed) {
          // 60 秒内刚寄过（可能上一次超时但其实寄出了）：直接去输入验证码
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
      return guarded('resend', async () => {
        const otp = await api.requestOtp(state.email);
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
          last = await loadLastUserId(store);
          owner = (await store.getMeta('owner_user_id')) || null;
        } catch (e) { notSaved('loadOwner')(e); return; }
        const prevOwner = owner || last; // 本地账本（可能）的主人
        // 换账号（spec §7.7、审核 M5）：清掉这台设备的账本（同一次写入连 session 一起写）。
        // 还有没上传的记录才问：已归属 → 待上传 + 无法同步；还没归属（没开始同步）→ 整本都没上传
        const switching = !!prevOwner && prevOwner !== s.user_id;
        if (switching) {
          const c = store.syncCounts();
          const unsynced = owner ? c.pending + c.errors > 0 : store.hasOwnedData();
          const go = !unsynced || await confirmReset({ txCount: owner ? c.txPending + c.txErrors : store.transactions().length });
          if (!go) {
            pendingUsed = true; // 这组验证码已被服务器用掉
            clearPending(store).catch(warn('clearPending'));
            Object.assign(state, { step: 'welcome', code: '', sentAt: null });
            setNotice('');
            return;
          }
        }
        // session、lastUserId（换账号时连清除与新 owner）同一次写入：要嘛全有要嘛全无
        const meta = { session: s, lastUserId: s.user_id };
        try {
          if (switching) await store.resetForAccount(s.user_id, { meta });
          else await store.setMetas(meta);
        } catch (e) { notSaved(switching ? 'resetForAccount' : 'saveSession')(e); return; }
        await clearPending(store).catch(warn('clearPending'));
        state.step = 'done';
        signedIn = s;
      });
      if (signedIn) onSignedIn(signedIn);
    },
  };
  return flow;
}
