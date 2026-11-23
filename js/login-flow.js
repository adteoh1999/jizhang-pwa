// 登录流程状态机：欢迎 → 邮箱（＋邀请码）→ 6 位数验证码 → 登录成功。不碰 DOM，画面由 js/ui/login.js 订阅后画。
// 规则：三个动作（发送、重发、验证）进行中再调一次直接忽略；busy 一律在 finally 复位。
import {
  normalizeEmailInput, cleanCode, OTP_TTL_MS, RESEND_MS,
  loadPending, savePending, clearPending, saveSession, loadLastUserId, saveLastUserId,
} from './auth.js';

const EXPIRED = '验证码已过期，请重新发送';
const UNEXPECTED = '出了点问题，请稍后再试';
const warn = (step) => (e) => console.warn(`[login] ${step} 失败：${e && e.name ? e.name : '未知'}`);

/**
 * api：{ registerEmail(email, invite), requestOtp(email), verifyOtp(email, code, nowMs) }（已绑好 fetch）
 * hasLocalData()：本地有没有账本（换账号确认用）；confirmSwitch()：Promise<boolean>
 */
export function createLoginFlow({ api, store, now = () => Date.now(), onSignedIn, hasLocalData = () => false, confirmSwitch = async () => true }) {
  const state = { step: 'welcome', email: '', code: '', busy: false, error: '', notice: '', sentAt: null };
  const listeners = new Set();
  let lastFailedCode = '';

  const emit = () => {
    const snap = { ...state };
    for (const fn of [...listeners]) {
      try { fn(snap); } catch (e) { console.error(e); }
    }
  };
  const set = (patch) => { Object.assign(state, patch); emit(); };

  // busy 包装：进行中直接忽略；不管成功失败都复位
  async function guarded(fn) {
    if (state.busy || state.step === 'done') return;
    set({ busy: true, error: '' });
    try {
      await fn();
    } catch (e) {
      warn('流程')(e);
      state.error = UNEXPECTED;
    } finally {
      set({ busy: false });
    }
  }

  function enterCode(email, sentAt, notice = '') {
    state.email = email;
    state.sentAt = sentAt;
    state.code = '';
    state.notice = notice;
    state.step = 'code';
    lastFailedCode = '';
    savePending(store, { email, sentAt }).catch(warn('savePending')); // 写不进去也照样进验证码页（信已寄出）
  }

  const flow = {
    get state() { return { ...state }; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    async start() {
      let p = null;
      try { p = await loadPending(store, now()); } catch (e) { warn('loadPending')(e); }
      if (p && !p.expired) {
        set({ step: 'code', email: p.email, sentAt: p.sentAt, code: '', notice: '', error: '' });
      } else if (p) {
        clearPending(store).catch(warn('clearPending'));
        set({ step: 'email', email: p.email, sentAt: null, notice: EXPIRED, error: '' });
      } else {
        set({ step: 'welcome' });
      }
    },

    goEmail() {
      if (state.busy) return;
      set({ step: 'email', error: '', notice: '' });
    },

    back() {
      if (state.busy) return;
      if (state.step === 'code') set({ step: 'email', error: '', notice: '', code: '' }); // pending 保留
      else if (state.step === 'email') set({ step: 'welcome', error: '', notice: '' });
    },

    /** 回到前景、或送出验证码前调：在验证码页而且已超过 10 分钟 → 回邮箱页。回 true 表示已过期。 */
    checkExpiry() {
      if (state.step !== 'code' || state.sentAt == null || now() - state.sentAt < OTP_TTL_MS) return false;
      clearPending(store).catch(warn('clearPending'));
      set({ step: 'email', code: '', sentAt: null, notice: EXPIRED, error: '' });
      return true;
    },

    resendLeft(nowMs = now()) {
      if (state.sentAt == null) return 0;
      const left = Math.ceil((state.sentAt + RESEND_MS - nowMs) / 1000);
      return Math.max(0, Math.min(RESEND_MS / 1000, left));
    },

    submitEmail(rawEmail, invite) {
      if (state.busy || state.step === 'done') return Promise.resolve();
      const email = normalizeEmailInput(rawEmail);
      if (!email) { set({ error: '请输入正确的邮箱', notice: '' }); return Promise.resolve(); }
      return guarded(async () => {
        state.notice = '';
        let pending = null;
        try { pending = await loadPending(store, now()); } catch (e) { warn('loadPending')(e); }
        if (pending && !pending.expired && pending.email === email) { enterCode(email, pending.sentAt); return; }

        const reg = await api.registerEmail(email, invite);
        if (!reg.ok) { state.email = email; state.error = reg.message; return; }
        const otp = await api.requestOtp(email);
        if (otp.ok) { enterCode(email, now()); return; }
        if (Number.isFinite(otp.retrySec)) {
          // 60 秒内刚寄过（可能上一次超时但其实寄出了）：直接去输入验证码
          const sentAt = pending && pending.email === email ? pending.sentAt : now() - (RESEND_MS - otp.retrySec * 1000);
          enterCode(email, sentAt, '验证码刚才已寄出');
          return;
        }
        state.email = email;
        state.error = otp.message;
      });
    },

    resend() {
      if (state.step !== 'code' || flow.resendLeft() > 0) return Promise.resolve();
      return guarded(async () => {
        const otp = await api.requestOtp(state.email);
        if (otp.ok) { enterCode(state.email, now(), '已重新发送'); return; }
        if (Number.isFinite(otp.retrySec)) state.sentAt = now() - (RESEND_MS - otp.retrySec * 1000);
        state.error = otp.message;
      });
    },

    /** 输入框每次变化都调；满 6 位自动送出（不重送刚失败的那一组）。 */
    inputCode(raw) {
      const code = cleanCode(raw);
      if (code !== state.code) set({ code, error: code ? '' : state.error });
      if (code.length === 6 && code !== lastFailedCode && !state.busy) return flow.submitCode();
      return Promise.resolve();
    },

    submitCode() {
      if (state.busy || state.step !== 'code') return Promise.resolve();
      if (flow.checkExpiry()) return Promise.resolve();
      const code = state.code;
      if (code.length !== 6) return Promise.resolve();
      return guarded(async () => {
        const r = await api.verifyOtp(state.email, code, now());
        if (!r.ok) {
          lastFailedCode = code;
          state.code = '';
          state.error = r.message;
          return;
        }
        const s = r.session;
        let last = null;
        try { last = await loadLastUserId(store); } catch (e) { warn('loadLastUserId')(e); }
        if (last && last !== s.user_id && hasLocalData()) {
          const go = await confirmSwitch();
          if (!go) {
            clearPending(store).catch(warn('clearPending'));
            Object.assign(state, { step: 'welcome', code: '', sentAt: null, notice: '' });
            return;
          }
        }
        try {
          await saveSession(store, s);
        } catch (e) {
          warn('saveSession')(e);
          Object.assign(state, { step: 'email', code: '', sentAt: null, error: '登录资料没存好，请重新发送验证码' });
          return;
        }
        // 等写完再进 App（失败只记日志：session 已存好，登录有效）
        await saveLastUserId(store, s.user_id).catch(warn('saveLastUserId'));
        await clearPending(store).catch(warn('clearPending'));
        state.step = 'done';
        onSignedIn(s);
      });
    },
  };
  return flow;
}
