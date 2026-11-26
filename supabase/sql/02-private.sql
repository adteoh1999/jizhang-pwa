-- 记账 App · 2b-2 内部表（private）与服务器函数（svc）
-- 用法：在 Supabase SQL Editor 贴上整个文件，按 Run。可以重复执行。
-- private：限流、邀请码、站主邮箱等内部表。不开放给 API，外人与一般用户都碰不到。
-- svc：服务器函数。只有后台万能钥匙（service_role）能用，Edge Function 经 /rest/v1/rpc 调用。
-- 函数一律 security definer + search_path = ''，内容写完整名称。
-- 改函数的参数或回传类型时，要先 drop function（create or replace 改不了）。

begin;

create extension if not exists pgcrypto with schema extensions;

-- ======================= private 表 =======================
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- 站主邮箱（由用户自己在 SQL Editor 插入，不进代码）
create table if not exists private.owner_emails (
  email text primary key check (email = lower(btrim(email)) and position('@' in email) > 1)
);

-- 每寄一封验证码记一笔（只留 2 天）
create table if not exists private.otp_sends (
  id      bigserial   primary key,
  email   text        not null,
  sent_at timestamptz not null default now()
);
create index if not exists otp_sends_email_idx on private.otp_sends (email, sent_at);
create index if not exists otp_sends_time_idx  on private.otp_sends (sent_at);

-- 一小时内太多次 → 锁 1 小时
create table if not exists private.otp_locks (
  email        text        primary key,
  locked_until timestamptz not null
);

-- 邀请码：8 个字，不含 0 O 1 I L
create table if not exists private.invite_codes (
  code       text        primary key check (code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$'),
  max_uses   integer     not null default 1 check (max_uses > 0),
  used_count integer     not null default 0 check (used_count >= 0),
  active     boolean     not null default true,
  expires_at timestamptz default (now() + interval '7 days'),
  note       text        not null default '',
  created_at timestamptz not null default now()
);

-- 邀请码使用纪录。status：reserved = 已扣码、账号还没建好；used = 已建好账号。
-- 用户被删除后 user_id 变 null，但 status 仍是 used（不会被当成保留，删号后要新码）。
create table if not exists private.invite_uses (
  id           bigserial   primary key,
  code         text        not null references private.invite_codes (code) on delete cascade,
  email        text        not null,
  user_id      uuid        references auth.users (id) on delete set null,
  display_name text        not null default '',
  status       text        not null default 'reserved' check (status in ('reserved', 'used')),
  used_at      timestamptz not null default now()
);
create unique index if not exists invite_uses_reserved_idx on private.invite_uses (code, email) where status = 'reserved';

-- 注册尝试（按 IP，IPv6 按 /64；没有 IP 记成 'noip'），防止猜邀请码；只留 2 天
create table if not exists private.register_attempts (
  id  bigserial   primary key,
  key text        not null,
  at  timestamptz not null default now()
);
create index if not exists register_attempts_key_idx on private.register_attempts (key, at);
create index if not exists register_attempts_at_idx on private.register_attempts (at);  -- 清理旧纪录、全站总数用

-- Telegram 连接（第 3 阶段）。D1（2026-11-26）：只连接邮箱账号，kind 一律 'email'，previous_user_id 不用（保留）。
-- 一个 Telegram 只连一个账号、一个账号只连一个 Telegram；账号删掉时连接跟着删。
create table if not exists private.telegram_links (
  telegram_id      bigint      primary key,
  user_id          uuid        not null unique references auth.users (id) on delete cascade,
  kind             text        not null check (kind in ('telegram', 'email')),
  previous_user_id uuid,
  linked_at        timestamptz not null default now()
);
-- tg_label：连接时的 Telegram 显示名（@username 或名字，最多 64 字），给账号本人在设置页看（3a）。
-- 注意：栏位已存在时整句跳过——以后要改 64 这个上限，得另写 alter table … drop/add constraint。
alter table private.telegram_links
  add column if not exists tg_label text not null default ''
  constraint telegram_links_tg_label_len check (char_length(tg_label) <= 64);

-- 3b：连接通知信（Q9②；r2-M2-2 (b)、S2-6，用户 2026-11-26 选）。
-- notified_at：这次连接的通知信「已处理」的时间（寄出、或因上限放弃）；null＝还没寄（bind 回 already 时会补寄）。
alter table private.telegram_links add column if not exists notified_at timestamptz;
-- 每寄一封通知信记一笔，给「同一账号 24 小时最多 3 封」用；只留 2 天。账号删掉时跟着删。
create table if not exists private.tg_notify_sends (
  id      bigserial   primary key,
  user_id uuid        not null references auth.users (id) on delete cascade,
  sent_at timestamptz not null default now()
);
create index if not exists tg_notify_sends_user_idx on private.tg_notify_sends (user_id, sent_at);
create index if not exists tg_notify_sends_at_idx   on private.tg_notify_sends (sent_at);

-- ---------- 3d：bot ＋ AI 记账 ----------
-- ai_ok_at：这个连接第一次用 AI 前按了［同意并开始］的时间（D4）；null＝还没同意。解除连接整列删掉，重新连接要再同意。
alter table private.telegram_links add column if not exists ai_ok_at timestamptz;

-- 每则 Telegram 讯息（update）的处理状态：去重、补发回复用。只留 2 天。
--   working 处理中｜done 已记账（tx_id）｜asked 已问「还要记吗」（pending_id）｜skipped 没记账（看不懂、次数用完…）
--   replied_at：回复成功送出的时间；null＝还没回（重送时补发）
create table if not exists private.bot_updates (
  update_id  bigint      primary key,
  telegram_id bigint     not null,
  user_id    uuid        not null references auth.users (id) on delete cascade,
  status     text        not null check (status in ('working', 'done', 'asked', 'skipped')),
  tx_id      uuid,
  pending_id uuid,
  replied_at timestamptz,
  claimed_at timestamptz not null default now()
);
create index if not exists bot_updates_claimed_idx on private.bot_updates (claimed_at);
create index if not exists bot_updates_user_idx    on private.bot_updates (user_id);

-- 每叫一次 AI 记一笔，给「每人／全站 24 小时内次数」用。只留 2 天。
create table if not exists private.bot_ai_uses (
  id      bigserial   primary key,
  user_id uuid        not null references auth.users (id) on delete cascade,
  at      timestamptz not null default now()
);
create index if not exists bot_ai_uses_user_idx on private.bot_ai_uses (user_id, at);
create index if not exists bot_ai_uses_at_idx   on private.bot_ai_uses (at);

-- 先问「还要记吗」的那一笔（相似或截图大额）。id 之后直接当账目 id（按两次也只记一笔）。只留 24 小时。
create table if not exists private.bot_pending (
  id            uuid        primary key,
  user_id       uuid        not null references auth.users (id) on delete cascade,
  telegram_id   bigint      not null,
  reason        text        not null check (reason in ('similar', 'big')),
  similar_tx_id uuid,
  kind          text        not null check (kind in ('expense', 'income')),
  amount_minor  bigint      not null check (amount_minor between 1 and 9999999999),
  category_id   text        not null check (char_length(category_id) between 1 and 64),
  occurred_on   date        not null,
  note          text        not null default '' check (char_length(note) <= 500),
  created_at    timestamptz not null default now()
);
create index if not exists bot_pending_user_idx on private.bot_pending (user_id);
create index if not exists bot_pending_time_idx on private.bot_pending (created_at);

-- 多一层防线：开 RLS、不建 policy（definer 函数不受影响）
alter table private.owner_emails      enable row level security;
alter table private.otp_sends         enable row level security;
alter table private.otp_locks         enable row level security;
alter table private.invite_codes      enable row level security;
alter table private.invite_uses       enable row level security;
alter table private.register_attempts enable row level security;
alter table private.telegram_links    enable row level security;
alter table private.tg_notify_sends   enable row level security;
alter table private.bot_updates       enable row level security;
alter table private.bot_ai_uses       enable row level security;
alter table private.bot_pending       enable row level security;

revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;

-- ======================= svc 函数 =======================
create schema if not exists svc;
revoke all on schema svc from public, anon, authenticated;
grant usage on schema svc to service_role;

-- 寄验证码前的检查＋登记（全部在同一个交易里原子完成）
-- 回传 {"ok":true,"id":N} 或 {"ok":false,"message":"…"}
create or replace function svc.svc_otp_reserve(p_email text) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '800ms' as $$
declare
  e          text        := lower(btrim(coalesce(p_email, '')));
  t          timestamptz := now();
  day_start  timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  lock_until timestamptz;
  last_at    timestamptz;
  n          integer;
  is_owner   boolean;
  new_id     bigint;
begin
  if position('@' in e) < 2 then
    return jsonb_build_object('ok', false, 'message', '邮箱格式不对');
  end if;

  -- 全站只有一把锁：同一时间只处理一个寄信请求（量很小，最简单也最稳）
  perform pg_advisory_xact_lock(hashtext('jizhang:otp'));

  delete from private.otp_sends where sent_at < t - interval '2 days';
  delete from private.otp_locks where locked_until <= t;

  -- 1. 被锁住（锁期间再试不延长）
  select locked_until into lock_until from private.otp_locks where email = e;
  if found then
    return jsonb_build_object('ok', false, 'message',
      format('已达到上限，请 %s 分钟后再试', ceil(extract(epoch from lock_until - t) / 60)::int));
  end if;

  -- 2. 60 秒内寄过
  select max(sent_at) into last_at from private.otp_sends where email = e;
  if last_at is not null and last_at > t - interval '60 seconds' then
    return jsonb_build_object('ok', false, 'message',
      format('请 %s 秒后再试', greatest(1, ceil(extract(epoch from last_at + interval '60 seconds' - t))::int)));
  end if;

  -- 3. 一小时内已 5 次 → 锁 1 小时
  select count(*) into n from private.otp_sends where email = e and sent_at > t - interval '60 minutes';
  if n >= 5 then
    insert into private.otp_locks (email, locked_until) values (e, t + interval '1 hour')
      on conflict (email) do nothing;
    return jsonb_build_object('ok', false, 'message', '已达到上限，请 60 分钟后再试');
  end if;

  -- 4. 同一邮箱 24 小时最多 10 封
  select count(*) into n from private.otp_sends where email = e and sent_at > t - interval '24 hours';
  if n >= 10 then
    return jsonb_build_object('ok', false, 'message', '这个邮箱今天已寄太多次验证码，请明天再试');
  end if;

  -- 5. 全站每日（UTC）：非站主合计 70 封；站主另外 10 封
  is_owner := exists (select 1 from private.owner_emails o where o.email = e);
  if is_owner then
    select count(*) into n from private.otp_sends s
      where s.sent_at >= day_start and exists (select 1 from private.owner_emails o where o.email = s.email);
    if n >= 10 then
      return jsonb_build_object('ok', false, 'message', '今天的验证码已达上限，请明天再试');
    end if;
  else
    select count(*) into n from private.otp_sends s
      where s.sent_at >= day_start and not exists (select 1 from private.owner_emails o where o.email = s.email);
    if n >= 70 then
      return jsonb_build_object('ok', false, 'message', '今天的验证码已达上限，请明天再试');
    end if;
  end if;

  insert into private.otp_sends (email, sent_at) values (e, t) returning id into new_id;
  return jsonb_build_object('ok', true, 'id', new_id);
end;
$$;

-- 寄信失败时撤回那一笔（不算次数）
create or replace function svc.svc_otp_release(p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from private.otp_sends where id = p_id;
end;
$$;

-- 注册前的检查：IP 是否太多次、全站是否太多次、邮箱是否已有账号、是不是站主
-- p_count = false（建账号后的复查）：不记、不限流，只回 exists / owner；传 null 当 true（不明就限流）
-- IP 归并：IPv4 按单一地址；IPv6 按 /64（同一个家用或手机网络算一个）；::ffff:x.x.x.x 当 IPv4
-- p_ip 是 null、空字串或不是 IP：不做 IP 限流，但仍算进全站总数（记成 'noip'）
-- 全站上限只挡「还没有账号、也不是站主」的邮箱：注册每次登录都会调用，已有账号的人不能被别人灌爆挡掉
--   已知取舍：已有账号的登录也算进全站总数；有人用大量 IPv6 灌满时，新用户这一小时内暂时不能注册
--   计数没加锁：同时进来的请求可能让 20 / 200 稍微超过一点，这个量级可以接受
--   部署顺序：先跑本文件，再部署新版 register（新版复查会带 p_count）
--   ::1.2.3.4（旧写法）、64:ff9b::/96（NAT64）按 IPv6 /64 处理，Cloudflare 不会送这些
-- 上限（2026-11-23 用户定）：同一 IP 每小时 20 次；全站每小时 200 次
drop function if exists svc.svc_register_check(text, text);
create or replace function svc.svc_register_check(p_email text, p_ip text, p_count boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  e       text    := lower(btrim(coalesce(p_email, '')));
  ex      boolean;
  own     boolean;
  ip      inet;
  k       text;
  limited boolean := false;
  n       integer;
begin
  ex  := exists (select 1 from auth.users u where lower(u.email) = e);
  own := exists (select 1 from private.owner_emails o where o.email = e);
  if p_count is not false then
    delete from private.register_attempts where at < now() - interval '2 days';
    begin
      ip := nullif(btrim(coalesce(p_ip, '')), '')::inet;
    exception when invalid_text_representation then
      ip := null;
    end;
    if ip is not null and family(ip) = 6 and ip << '::ffff:0.0.0.0/96'::inet then
      ip := '0.0.0.0'::inet + (host(ip)::inet - '::ffff:0.0.0.0'::inet);
    end if;
    if ip is not null then
      if family(ip) = 6 then
        k := 'ip:' || network(set_masklen(ip, 64))::text;
      else
        k := 'ip:' || host(ip);
      end if;
      select count(*) into n from private.register_attempts where key = k and at > now() - interval '1 hour';
      limited := n >= 20;
    end if;
    if not limited and not ex and not own then
      select count(*) into n from private.register_attempts where at > now() - interval '1 hour';
      limited := n >= 200;
    end if;
    if not limited then
      insert into private.register_attempts (key) values (coalesce(k, 'noip'));
    end if;
  end if;
  return jsonb_build_object(
    'limited', limited,
    'exists',  ex,
    'owner',   own
  );
end;
$$;

-- 扣邀请码。同一邮箱拿同一个码在 15 分钟内重试，不会重复扣。p_code 进来前已正规化（8 个大写字）
-- 超过 15 分钟的保留视为已使用（账号可能已建好、只是没记录到），之后要照正常规则再扣
create or replace function svc.svc_redeem_invite(p_code text, p_email text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  e text := lower(btrim(coalesce(p_email, '')));
  c private.invite_codes%rowtype;
begin
  select * into c from private.invite_codes where code = p_code for update;
  if not found then
    return false;
  end if;
  update private.invite_uses set status = 'used'
    where code = p_code and email = e and status = 'reserved' and used_at < now() - interval '15 minutes';
  if exists (select 1 from private.invite_uses where code = p_code and email = e and status = 'reserved') then
    return true;
  end if;
  if not c.active or (c.expires_at is not null and c.expires_at <= now()) or c.used_count >= c.max_uses then
    return false;
  end if;
  update private.invite_codes set used_count = used_count + 1 where code = p_code;
  insert into private.invite_uses (code, email, status) values (p_code, e, 'reserved');
  return true;
end;
$$;

-- 建账号失败：退回那次保留（没有保留就什么都不做）
create or replace function svc.svc_refund_invite(p_code text, p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  e text := lower(btrim(coalesce(p_email, '')));
begin
  perform 1 from private.invite_codes where code = p_code for update;
  delete from private.invite_uses where code = p_code and email = e and status = 'reserved';
  if found then
    update private.invite_codes set used_count = greatest(used_count - 1, 0) where code = p_code;
  end if;
end;
$$;

-- 建账号成功：保留改成已使用并记下 user_id；找不到保留就补写一笔
create or replace function svc.svc_record_invite_use(p_code text, p_email text, p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  e text := lower(btrim(coalesce(p_email, '')));
begin
  update private.invite_uses set status = 'used', user_id = p_user_id, used_at = now()
    where code = p_code and email = e and status = 'reserved';
  if not found then
    insert into private.invite_uses (code, email, user_id, status) values (p_code, e, p_user_id, 'used');
  end if;
end;
$$;

-- 站主判断（2f）：邮箱比对前先转小写、去空白；null 当成不是
create or replace function svc.svc_is_owner(p_email text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.owner_emails o where o.email = lower(btrim(coalesce(p_email, ''))));
$$;

-- 产生新邀请码，回传 8 个字（不加连字号）
-- 次数 1–20；天数 1–365，传 null = 永不过期；备注最多 40 字（超过就截掉）
create or replace function svc.svc_new_invite_code(p_max_uses integer default 1, p_days integer default 7, p_note text default '')
returns text
language plpgsql security definer set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';  -- 31 个字
  v_code text;
  b      bytea;
  x      integer;
begin
  if p_max_uses is null or p_max_uses < 1 or p_max_uses > 20 then
    raise exception '可用次数要在 1 到 20 之间';
  end if;
  if p_days is not null and (p_days < 1 or p_days > 365) then
    raise exception '天数要在 1 到 365 之间';
  end if;
  loop
    v_code := '';
    while length(v_code) < 8 loop
      b := extensions.gen_random_bytes(16);
      for i in 0..15 loop
        x := get_byte(b, i);
        if x < 248 then  -- 248 = 31 × 8；超过就丢掉重抽，每个字机率才会一样
          v_code := v_code || substr(alphabet, (x % 31) + 1, 1);
          exit when length(v_code) = 8;
        end if;
      end loop;
    end loop;
    begin
      insert into private.invite_codes (code, max_uses, expires_at, note)
        values (v_code, p_max_uses,
                case when p_days is null then null else now() + make_interval(days => p_days) end,
                left(coalesce(p_note, ''), 40));
      return v_code;
    exception when unique_violation then
      null;  -- 撞到旧码，重抽
    end;
  end loop;
end;
$$;

-- 邀请码清单（2f），由新到旧。status 依序判断：disabled → used_up → expired → active
create or replace function svc.svc_invites_list() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'code',       c.code,
           'max_uses',   c.max_uses,
           'used_count', c.used_count,
           'active',     c.active,
           'expires_at', c.expires_at,
           'note',       c.note,
           'created_at', c.created_at,
           'status',     case
                           when not c.active                                       then 'disabled'
                           when c.used_count >= c.max_uses                         then 'used_up'
                           when c.expires_at is not null and c.expires_at <= now() then 'expired'
                           else 'active'
                         end)
         order by c.created_at desc, c.code), '[]'::jsonb)
    from private.invite_codes c;
$$;

-- 停用／重新启用（2f）。找不到码回 false
create or replace function svc.svc_invite_set_active(p_code text, p_active boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_active is null then
    raise exception 'active 不能是 null';
  end if;
  update private.invite_codes set active = p_active where code = p_code;
  return found;
end;
$$;

-- 某个码的使用明细（2f），由新到旧
-- user_id：纪录上有就用；没有（旧纪录或没记到）就用邮箱对现有账号
-- 列出：已使用（used）；保留（reserved）但邮箱对得到账号（账号建好了、只是没记到，当一般使用者）；
--       保留、对不到账号、超过 15 分钟 → pending = true（前端显示「注册未完成」）。刚保留又没账号的不列（可能正在注册）
-- deleted：不是 pending，且对不到活着的账号（email 已清空、或那个邮箱已没有账号）
--   email 已清空但账号还在（删号做到一半）→ deleted = false，前端显示「删除未完成」、可以再移除一次
-- owner：快照邮箱「或」账号现在的邮箱是站主，任一成立就算（deleted 时一律 false）
-- user_id 只给 Edge Function 内部判断用，回前端前要拿掉
create or replace function svc.svc_invite_uses(p_code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with base as (
    select iu.id, iu.email, iu.used_at, iu.status,
           coalesce(iu.user_id,
                    case when iu.email <> '' then
                      (select u.id from auth.users u where lower(u.email) = iu.email order by u.created_at limit 1)
                    end) as uid
      from private.invite_uses iu
     where iu.code = p_code
  ), flagged as (
    select b.*, (b.status = 'reserved' and b.uid is null and b.email <> '') as pending
      from base b
     where b.status = 'used' or b.uid is not null or b.used_at < now() - interval '15 minutes'
  ), marked as (
    select f.*,
           (f.uid is null and not f.pending) as deleted,
           (select lower(u.email) from auth.users u where u.id = f.uid) as cur_email
      from flagged f
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',      m.id,
           'user_id', m.uid,
           'email',   m.email,
           'used_at', m.used_at,
           'deleted', m.deleted,
           'owner',   not m.deleted and (svc.svc_is_owner(m.email) or svc.svc_is_owner(m.cur_email)),
           'pending', m.pending)
         order by m.used_at desc, m.id desc), '[]'::jsonb)
    from marked m;
$$;

-- 删除某个用户的全部资料（2f：删号、站主移除用户都先叫这个，再删 auth 账号）。可以重复执行
-- 使用纪录不删（码的次数照算），只清掉邮箱与名字：user_id 是这个人的，或 user_id 没记到但邮箱是他的（含保留列）
-- 保留列一起改成 used：人确实用过这个码；而且两笔保留都清成 '' 会撞 (code, email) where reserved 的唯一索引
-- 账号已不存在（重复执行）时查不到邮箱，只清 user_id 对得上的
create or replace function svc.svc_delete_user_data(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_email text;
begin
  if p_user_id is null then
    raise exception 'user_id 不能是 null';
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = p_user_id;
  delete from public.transactions      where user_id = p_user_id;
  delete from public.categories        where user_id = p_user_id;
  delete from public.category_keywords where user_id = p_user_id;
  delete from private.telegram_links   where user_id = p_user_id;
  delete from private.tg_notify_sends  where user_id = p_user_id;
  delete from private.bot_updates      where user_id = p_user_id;
  delete from private.bot_ai_uses      where user_id = p_user_id;
  delete from private.bot_pending      where user_id = p_user_id;
  update private.invite_uses set email = '', display_name = '', status = 'used'
   where user_id = p_user_id
      or (v_email is not null and v_email <> '' and user_id is null and email = v_email);
end;
$$;

-- ======================= Telegram 连接（3a） =======================
-- 参数不合格一律 raise exception（那是程式错误，不是使用者情况）。

-- 这个 Telegram 连着哪个账号；没有回 null
create or replace function svc.svc_tg_link_get(p_telegram_id bigint) returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_telegram_id is null or p_telegram_id <= 0 then
    raise exception 'telegram_id 不合格';
  end if;
  return (select l.user_id from private.telegram_links l where l.telegram_id = p_telegram_id);
end;
$$;

-- 连接一个 Telegram 与一个邮箱账号。回传 linked / already / telegram_taken / user_taken / no_user / not_email。
-- 判断顺序固定（verify-3a 第 6、7 项会检查）：参数 → 账号 → 这个 Telegram → 这个账号 → 插入。
-- 全站一把锁，所以正常不会撞唯一约束；撞到时重判一次（保险），重判后仍查不到就往外报错。
create or replace function svc.svc_tg_bind(p_telegram_id bigint, p_user_id uuid, p_label text) returns text
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_label   text    := left(btrim(coalesce(p_label, '')), 64);
  v_kind    text;
  v_email   text;
  v_owner   uuid;
  v_retried boolean := false;
begin
  if p_telegram_id is null or p_telegram_id <= 0 then
    raise exception 'telegram_id 不合格';
  end if;
  if p_user_id is null then
    raise exception 'user_id 不能是 null';
  end if;

  -- 全站只有一把锁：同一时间只处理一个连接请求（量很小，最简单也最稳）
  perform pg_advisory_xact_lock(hashtext('jizhang:tg-bind'));

  -- 账号：要存在、是邮箱账号（register 建号时写的 app_metadata.kind，用户自己改不了），而且 email 不是空的（异常资料不连）。
  -- 注意：删号「资料已删、auth 账号删失败」的半删账号 email 还在，仍可连接；重试删号时连接会跟着账号 cascade 删掉（3a S1，用户 2026-11-26 接受）
  select u.raw_app_meta_data->>'kind', u.email into v_kind, v_email from auth.users u where u.id = p_user_id;
  if not found then
    return 'no_user';
  end if;
  if v_kind is distinct from 'email' or coalesce(btrim(v_email), '') = '' then
    return 'not_email';
  end if;

  loop
    -- 这个 Telegram 已经连着谁
    select l.user_id into v_owner from private.telegram_links l where l.telegram_id = p_telegram_id;
    if found then
      if v_owner = p_user_id then
        if v_label <> '' then
          update private.telegram_links set tg_label = v_label where telegram_id = p_telegram_id;
        end if;
        return 'already';
      end if;
      return 'telegram_taken';
    end if;
    -- 这个账号是不是已经连着别的 Telegram
    if exists (select 1 from private.telegram_links l where l.user_id = p_user_id) then
      return 'user_taken';
    end if;
    if v_retried then
      raise exception '连接时撞到唯一约束，重判后却查不到连接';
    end if;
    begin
      insert into private.telegram_links (telegram_id, user_id, kind, tg_label)
      values (p_telegram_id, p_user_id, 'email', v_label);
      return 'linked';
    exception
      when unique_violation then
        v_retried := true;   -- 回到 loop 开头重判一次
      when foreign_key_violation then
        return 'no_user';    -- 账号刚好被删
    end;
  end loop;
end;
$$;

-- 解除这个账号的 Telegram 连接；有删到回 true，本来就没有回 false
create or replace function svc.svc_tg_unlink(p_user_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  n integer;
begin
  if p_user_id is null then
    raise exception 'user_id 不能是 null';
  end if;
  delete from private.telegram_links where user_id = p_user_id;
  get diagnostics n = row_count;
  delete from private.bot_pending where user_id = p_user_id;  -- 3d：旧的「还要记吗」按钮一起失效
  return n > 0;
end;
$$;

-- 设置页用：{"linked": true, "label": …, "linked_at": …} 或 {"linked": false}。
-- 故意不回 telegram_id（前端用不到）。注意：要确认「连着的是不是这一个 Telegram」请用 svc_tg_link_get 比对 user_id。
create or replace function svc.svc_tg_status(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_label  text;
  v_linked timestamptz;
begin
  if p_user_id is null then
    raise exception 'user_id 不能是 null';
  end if;
  select l.tg_label, l.linked_at into v_label, v_linked from private.telegram_links l where l.user_id = p_user_id;
  if not found then
    return jsonb_build_object('linked', false);
  end if;
  return jsonb_build_object('linked', true, 'label', v_label, 'linked_at', v_linked);
end;
$$;

-- ======================= Telegram 登录与通知信（3b） =======================

-- tg-login 用：这个 Telegram 有连接 → 更新名字（去空白后是空的就不改；截 64 字）并回 user_id；没有连接 → null。
-- 只 update、绝不 insert（新连接一律走 svc_tg_bind）。
create or replace function svc.svc_tg_touch(p_telegram_id bigint, p_label text) returns uuid
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_label text := left(btrim(coalesce(p_label, '')), 64);
  v_uid   uuid;
begin
  if p_telegram_id is null or p_telegram_id <= 0 then
    raise exception 'telegram_id 不合格';
  end if;
  update private.telegram_links
     set tg_label = case when v_label <> '' then v_label else tg_label end
   where telegram_id = p_telegram_id
  returning user_id into v_uid;
  return v_uid;
end;
$$;

-- tg-link bind 成功（linked 或 already）后用：要不要寄连接通知信。锁住这一笔连接，所以同时两个请求也只会寄一封。
--   {"do":"skip"}           ：连接不在、连的不是这个账号、或这次连接已处理过
--   {"do":"limited"}        ：这个账号 24 小时内已寄 3 封 → 记成已处理、不寄
--   {"do":"send","id":<n>,"linked_at":…}：先占位（记一笔、设 notified_at），寄信失败要叫 svc_tg_notify_release；
--                            linked_at 给 Resend 幂等键用（同一次连接同一个键）。notified_at 与那一笔的 sent_at 写同一个值（release 靠它比对）
create or replace function svc.svc_tg_notify_reserve(p_telegram_id bigint, p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_now      timestamptz := now();
  v_notified timestamptz;
  v_linked   timestamptz;
  n          integer;
  v_id       bigint;
begin
  if p_telegram_id is null or p_telegram_id <= 0 then
    raise exception 'telegram_id 不合格';
  end if;
  if p_user_id is null then
    raise exception 'user_id 不能是 null';
  end if;
  delete from private.tg_notify_sends where sent_at < v_now - interval '2 days';
  select l.notified_at, l.linked_at into v_notified, v_linked from private.telegram_links l
   where l.telegram_id = p_telegram_id and l.user_id = p_user_id
     for update;
  if not found or v_notified is not null then
    return jsonb_build_object('do', 'skip');
  end if;
  select count(*) into n from private.tg_notify_sends s
   where s.user_id = p_user_id and s.sent_at > v_now - interval '24 hours';
  update private.telegram_links set notified_at = v_now where telegram_id = p_telegram_id;
  if n >= 3 then
    return jsonb_build_object('do', 'limited');
  end if;
  insert into private.tg_notify_sends (user_id, sent_at) values (p_user_id, v_now) returning id into v_id;
  return jsonb_build_object('do', 'send', 'id', v_id, 'linked_at', v_linked);
end;
$$;

-- 通知信没寄出去：删掉占位的那一笔，并把这次连接改回「还没寄」。
-- 只在那一笔属于这个连接的账号、而且 notified_at 正是那次预约设的（reserve 把同一个值写进 notified_at 与 sent_at）时才改：
-- 预约后连接被解除又重新连接，新连接的 notified_at 不会被旧请求清掉（3b 审核 S6）。
create or replace function svc.svc_tg_notify_release(p_id bigint, p_telegram_id bigint) returns void
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_uid  uuid;
  v_sent timestamptz;
begin
  if p_id is null or p_telegram_id is null or p_telegram_id <= 0 then
    raise exception '参数不合格';
  end if;
  delete from private.tg_notify_sends where id = p_id returning user_id, sent_at into v_uid, v_sent;
  if v_uid is not null then
    update private.telegram_links set notified_at = null
     where telegram_id = p_telegram_id and user_id = v_uid and notified_at = v_sent;
  end if;
end;
$$;

-- ======================= bot ＋ AI 记账（3d） =======================
-- 参数一律收 telegram_id（总计划 r1-6、3d 计划 M8）：函数里自己查 user_id，结构上写不到别人的账；连接不在 → gone／unlinked。
-- 「按人上锁」（M1）：同一个人的 ai_reserve、record、confirm 一个一个来（相簿多张同时送也不会绕过相似检查）。
-- 全站次数只在个人锁里数：很多人同时用时可能超过上限几次，可以接受。

-- 内部小工具（放 private，不开放给 API）：一笔账的 json；这个人没有这笔 → null
create or replace function private.bot_tx_json(p_user uuid, p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', t.id, 'kind', t.kind, 'amount_minor', t.amount_minor, 'category_id', t.category_id,
                            'occurred_on', t.occurred_on, 'note', t.note, 'deleted', t.deleted)
    from public.transactions t where t.user_id = p_user and t.id = p_id;
$$;

-- 内部小工具：record／claim（补发）共用的结果。done → recorded＋tx；asked → asked＋pending（＋similar）；
-- pending 已不在（按过、过期）或状态不是这两种 → null
create or replace function private.bot_outcome(p_user uuid, p_status text, p_tx uuid, p_pending uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  p private.bot_pending;
begin
  if p_status = 'done' then
    return jsonb_build_object('status', 'recorded', 'tx', private.bot_tx_json(p_user, p_tx));
  elsif p_status = 'asked' then
    select * into p from private.bot_pending b where b.id = p_pending and b.user_id = p_user;
    if not found then
      return null;
    end if;
    return jsonb_build_object('status', 'asked', 'reason', p.reason,
      'pending', jsonb_build_object('id', p.id, 'kind', p.kind, 'amount_minor', p.amount_minor, 'category_id', p.category_id,
                                    'occurred_on', p.occurred_on, 'note', p.note),
      'similar', case when p.similar_tx_id is null then null else private.bot_tx_json(p_user, p.similar_tx_id) end);
  end if;
  return null;
end;
$$;

create or replace function private.bot_lock_user(p_user uuid) returns void
language sql security definer set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('bot:' || p_user::text, 0));
$$;

revoke all on function private.bot_tx_json(uuid, uuid)                from public, anon, authenticated;
revoke all on function private.bot_outcome(uuid, text, uuid, uuid)     from public, anon, authenticated;
revoke all on function private.bot_lock_user(uuid)                     from public, anon, authenticated;

-- 领取一则讯息（去重）。回传：
--   {"do":"unlinked"}               没连接（不写表）
--   {"do":"go","ai_ok":bool}        新的，或「处理中」超过 2 分钟、还没回复过（上次当掉）→ 重新领
--   {"do":"busy"}                   2 分钟内另一个执行正在处理
--   {"do":"resend", …bot_outcome}   已记账／已问过但还没回复成功 → 补发
--   {"do":"dup"}                    其他（已回复、没记账、pending 已不在）
-- 顺手清旧资料：bot_updates、bot_ai_uses 2 天，bot_pending 24 小时。
create or replace function svc.svc_bot_claim(p_update_id bigint, p_telegram_id bigint) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_user  uuid;
  v_ai    timestamptz;
  r       private.bot_updates;
  v_out   jsonb;
begin
  if p_update_id is null or p_update_id <= 0 then
    raise exception 'update_id 不合格';
  end if;
  if p_telegram_id is null or p_telegram_id <= 0 then
    raise exception 'telegram_id 不合格';
  end if;
  -- 清旧资料时跳过别人正锁着的列（两个 claim 同时清同一批不会互等）
  delete from private.bot_updates where update_id in
    (select update_id from private.bot_updates where claimed_at < now() - interval '2 days' for update skip locked);
  delete from private.bot_ai_uses where id in
    (select id from private.bot_ai_uses where at < now() - interval '2 days' for update skip locked);
  delete from private.bot_pending where id in
    (select id from private.bot_pending where created_at < now() - interval '24 hours' for update skip locked);

  select l.user_id, l.ai_ok_at into v_user, v_ai from private.telegram_links l where l.telegram_id = p_telegram_id;
  if not found then
    return jsonb_build_object('do', 'unlinked');
  end if;

  insert into private.bot_updates (update_id, telegram_id, user_id, status)
  values (p_update_id, p_telegram_id, v_user, 'working')
  on conflict (update_id) do nothing;
  if found then
    return jsonb_build_object('do', 'go', 'ai_ok', v_ai is not null);
  end if;

  select * into r from private.bot_updates where update_id = p_update_id for update;
  if r.telegram_id <> p_telegram_id then
    return jsonb_build_object('do', 'dup');
  end if;
  if r.status = 'working' then
    if r.replied_at is not null then
      return jsonb_build_object('do', 'dup');   -- 已回复过（例如看不懂、finish 没成功）：不再叫 AI
    end if;
    if r.claimed_at > now() - interval '2 minutes' then
      return jsonb_build_object('do', 'busy');
    end if;
    update private.bot_updates set claimed_at = now(), user_id = v_user where update_id = p_update_id;
    return jsonb_build_object('do', 'go', 'ai_ok', v_ai is not null);
  end if;
  if r.replied_at is null and r.user_id = v_user then
    v_out := private.bot_outcome(r.user_id, r.status, r.tx_id, r.pending_id);
    if v_out is not null then
      return jsonb_build_object('do', 'resend') || v_out;
    end if;
  end if;
  return jsonb_build_object('do', 'dup');
end;
$$;

-- 回复成功送出后记下来（之后重送不再补发）
create or replace function svc.svc_bot_replied(p_update_id bigint, p_telegram_id bigint) returns void
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
begin
  if p_update_id is null or p_update_id <= 0 or p_telegram_id is null or p_telegram_id <= 0 then
    raise exception '参数不合格';
  end if;
  update private.bot_updates set replied_at = now() where update_id = p_update_id and telegram_id = p_telegram_id;
end;
$$;

-- 这则讯息没记账（看不懂、次数用完、AI 失败…）：处理中 → skipped
create or replace function svc.svc_bot_finish(p_update_id bigint, p_telegram_id bigint) returns void
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
begin
  if p_update_id is null or p_update_id <= 0 or p_telegram_id is null or p_telegram_id <= 0 then
    raise exception '参数不合格';
  end if;
  update private.bot_updates set status = 'skipped'
   where update_id = p_update_id and telegram_id = p_telegram_id and status = 'working';
end;
$$;

-- 按了［同意并开始］（D4）：记下同意时间（已有就不改）。回传连接在不在。
create or replace function svc.svc_bot_ai_consent(p_telegram_id bigint) returns boolean
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
begin
  if p_telegram_id is null or p_telegram_id <= 0 then
    raise exception 'telegram_id 不合格';
  end if;
  update private.telegram_links set ai_ok_at = coalesce(ai_ok_at, now()) where telegram_id = p_telegram_id;
  return found;
end;
$$;

-- 叫 AI 前占一次次数。{"ok":true,"use_id":n}｜{"ok":false,"why":"user"|"site"|"gone"}
create or replace function svc.svc_bot_ai_reserve(p_telegram_id bigint, p_user_max integer, p_site_max integer) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_user uuid;
  n      integer;
  v_id   bigint;
begin
  if p_telegram_id is null or p_telegram_id <= 0 then
    raise exception 'telegram_id 不合格';
  end if;
  if p_user_max is null or p_user_max not between 1 and 1000 or p_site_max is null or p_site_max not between 1 and 1000 then
    raise exception '上限不合格';
  end if;
  select l.user_id into v_user from private.telegram_links l where l.telegram_id = p_telegram_id;
  if not found then
    return jsonb_build_object('ok', false, 'why', 'gone');
  end if;
  perform private.bot_lock_user(v_user);
  select count(*) into n from private.bot_ai_uses where user_id = v_user and at > now() - interval '24 hours';
  if n >= p_user_max then
    return jsonb_build_object('ok', false, 'why', 'user');
  end if;
  select count(*) into n from private.bot_ai_uses where at > now() - interval '24 hours';
  if n >= p_site_max then
    return jsonb_build_object('ok', false, 'why', 'site');
  end if;
  insert into private.bot_ai_uses (user_id) values (v_user) returning id into v_id;
  return jsonb_build_object('ok', true, 'use_id', v_id);
end;
$$;

-- AI 那边出错（没算钱）：退回这一次。只退这个人的、5 分钟内的那一笔。
create or replace function svc.svc_bot_ai_refund(p_telegram_id bigint, p_use_id bigint) returns void
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
begin
  if p_telegram_id is null or p_telegram_id <= 0 or p_use_id is null then
    raise exception '参数不合格';
  end if;
  delete from private.bot_ai_uses a
   using private.telegram_links l
   where l.telegram_id = p_telegram_id and a.user_id = l.user_id and a.id = p_use_id and a.at > now() - interval '5 minutes';
end;
$$;

-- 全站 24 小时内叫了几次 AI（站主「检查 Telegram bot」看）
create or replace function svc.svc_bot_ai_count() returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::integer from private.bot_ai_uses where at > now() - interval '24 hours';
$$;

-- 这个人服务器上的分类（含已删除，合并内建分类要用）；没连接 → null
create or replace function svc.svc_bot_categories(p_telegram_id bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_user uuid;
begin
  if p_telegram_id is null or p_telegram_id <= 0 then
    raise exception 'telegram_id 不合格';
  end if;
  select l.user_id into v_user from private.telegram_links l where l.telegram_id = p_telegram_id;
  if not found then
    return null;
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'name', c.name, 'sort', c.sort, 'deleted', c.deleted))
                     from public.categories c where c.user_id = v_user), '[]'::jsonb);
end;
$$;

-- 记一笔（同一个交易：闸门、相似、大额、写账、记状态）。回传 bot_outcome 的形状，或 {"status":"gone"}。
-- 闸门：这则 update 必须是这个 telegram 的「处理中」，而且领取时的账号就是现在连着的账号（M4）。
-- 相似（D3）：这个人没删除、同收支、同金额、同一天的账 → 先问。否则截图大额（p_ask_big，D2）→ 先问。
create or replace function svc.svc_bot_record(
  p_update_id bigint, p_telegram_id bigint, p_kind text, p_amount_minor bigint, p_category_id text,
  p_occurred_on date, p_note text, p_ask_big boolean
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_user    uuid;
  v_similar uuid;
  v_id      uuid := gen_random_uuid();
begin
  if p_update_id is null or p_update_id <= 0 or p_telegram_id is null or p_telegram_id <= 0 then
    raise exception '参数不合格';
  end if;
  if p_kind is null or p_kind not in ('expense', 'income')
     or p_amount_minor is null or p_amount_minor not between 1 and 9999999999
     or p_category_id is null or char_length(p_category_id) not between 1 and 64
     or p_occurred_on is null or p_note is null or char_length(p_note) > 500 or p_ask_big is null then
    raise exception '账目栏位不合格';
  end if;
  select l.user_id into v_user from private.telegram_links l where l.telegram_id = p_telegram_id;
  if not found then
    return jsonb_build_object('status', 'gone');
  end if;
  perform private.bot_lock_user(v_user);

  select t.id into v_similar from public.transactions t
   where t.user_id = v_user and not t.deleted and t.kind = p_kind
     and t.amount_minor = p_amount_minor and t.occurred_on = p_occurred_on
   order by t.created_at desc limit 1;

  if v_similar is not null or p_ask_big then
    update private.bot_updates set status = 'asked', pending_id = v_id
     where update_id = p_update_id and telegram_id = p_telegram_id and status = 'working' and user_id = v_user;
    if not found then
      return jsonb_build_object('status', 'gone');
    end if;
    insert into private.bot_pending (id, user_id, telegram_id, reason, similar_tx_id, kind, amount_minor, category_id, occurred_on, note)
    values (v_id, v_user, p_telegram_id, case when v_similar is not null then 'similar' else 'big' end, v_similar,
            p_kind, p_amount_minor, p_category_id, p_occurred_on, p_note);
    return private.bot_outcome(v_user, 'asked', null, v_id);
  end if;

  update private.bot_updates set status = 'done', tx_id = v_id
   where update_id = p_update_id and telegram_id = p_telegram_id and status = 'working' and user_id = v_user;
  if not found then
    return jsonb_build_object('status', 'gone');
  end if;
  insert into public.transactions (user_id, id, kind, amount_minor, category_id, occurred_on, note, created_at, updated_at, source)
  values (v_user, v_id, p_kind, p_amount_minor, p_category_id, p_occurred_on, p_note, now(), now(), 'bot');
  return private.bot_outcome(v_user, 'done', v_id, null);
end;
$$;

-- 按了［还要记］／［要记］：pending 变成账（账目 id = pending id）。按两次 → 第二次照样回 recorded、只有一笔（S8）。
create or replace function svc.svc_bot_confirm(p_telegram_id bigint, p_pending_id uuid) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_user uuid;
  p      private.bot_pending;
begin
  if p_telegram_id is null or p_telegram_id <= 0 or p_pending_id is null then
    raise exception '参数不合格';
  end if;
  select l.user_id into v_user from private.telegram_links l where l.telegram_id = p_telegram_id;
  if not found then
    return jsonb_build_object('status', 'gone');
  end if;
  perform private.bot_lock_user(v_user);
  delete from private.bot_pending b
   where b.id = p_pending_id and b.user_id = v_user and b.created_at > now() - interval '24 hours'
  returning * into p;
  if found then
    insert into public.transactions (user_id, id, kind, amount_minor, category_id, occurred_on, note, created_at, updated_at, source)
    values (v_user, p.id, p.kind, p.amount_minor, p.category_id, p.occurred_on, p.note, now(), now(), 'bot')
    on conflict (user_id, id) do nothing;
  elsif not exists (select 1 from public.transactions t where t.user_id = v_user and t.id = p_pending_id and t.source = 'bot') then
    return jsonb_build_object('status', 'gone');
  end if;
  return jsonb_build_object('status', 'recorded', 'tx', private.bot_tx_json(v_user, p_pending_id));
end;
$$;

-- 按了［不用］：丢掉 pending。回传有没有丢到。
create or replace function svc.svc_bot_discard(p_telegram_id bigint, p_pending_id uuid) returns boolean
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
begin
  if p_telegram_id is null or p_telegram_id <= 0 or p_pending_id is null then
    raise exception '参数不合格';
  end if;
  delete from private.bot_pending b
   using private.telegram_links l
   where l.telegram_id = p_telegram_id and b.user_id = l.user_id and b.id = p_pending_id;
  return found;
end;
$$;

-- 读一笔 bot 记的账（改分类选单、补发用）；不是这个人的、不是 bot 记的 → null
create or replace function svc.svc_bot_tx(p_telegram_id bigint, p_tx_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_user uuid;
begin
  if p_telegram_id is null or p_telegram_id <= 0 or p_tx_id is null then
    raise exception '参数不合格';
  end if;
  select l.user_id into v_user from private.telegram_links l where l.telegram_id = p_telegram_id;
  if not found then
    return null;
  end if;
  return (select private.bot_tx_json(v_user, t.id) from public.transactions t
           where t.user_id = v_user and t.id = p_tx_id and t.source = 'bot');
end;
$$;

-- 撤销一笔 bot 记的账（标记删除，照 LWW：updated_at = max(旧 + 1 毫秒, 现在)）。
-- {"status":"done","tx":…}｜not_found｜already｜busy（影响 0 列：LWW 略过，绝不说已撤销，M2）
create or replace function svc.svc_bot_undo(p_telegram_id bigint, p_tx_id uuid) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_user uuid;
  t      public.transactions;
  n      integer;
begin
  if p_telegram_id is null or p_telegram_id <= 0 or p_tx_id is null then
    raise exception '参数不合格';
  end if;
  select l.user_id into v_user from private.telegram_links l where l.telegram_id = p_telegram_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  select * into t from public.transactions x
   where x.user_id = v_user and x.id = p_tx_id and x.source = 'bot' for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if t.deleted then
    return jsonb_build_object('status', 'already');
  end if;
  update public.transactions set deleted = true, updated_at = greatest(t.updated_at + interval '1 millisecond', now())
   where user_id = v_user and id = p_tx_id;
  get diagnostics n = row_count;
  if n <> 1 then
    return jsonb_build_object('status', 'busy');
  end if;
  return jsonb_build_object('status', 'done', 'tx', private.bot_tx_json(v_user, p_tx_id));
end;
$$;

-- 改一笔 bot 记的账的分类（kind 跟着分类；分类合不合法由 Edge Function 用合并后的清单判断）。
-- {"status":"done","tx":…}｜not_found｜deleted｜busy
create or replace function svc.svc_bot_set_category(p_telegram_id bigint, p_tx_id uuid, p_category_id text, p_kind text) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_user uuid;
  t      public.transactions;
  n      integer;
begin
  if p_telegram_id is null or p_telegram_id <= 0 or p_tx_id is null
     or p_category_id is null or char_length(p_category_id) not between 1 and 64
     or p_kind is null or p_kind not in ('expense', 'income') then
    raise exception '参数不合格';
  end if;
  select l.user_id into v_user from private.telegram_links l where l.telegram_id = p_telegram_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  select * into t from public.transactions x
   where x.user_id = v_user and x.id = p_tx_id and x.source = 'bot' for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if t.deleted then
    return jsonb_build_object('status', 'deleted');
  end if;
  update public.transactions
     set category_id = p_category_id, kind = p_kind, updated_at = greatest(t.updated_at + interval '1 millisecond', now())
   where user_id = v_user and id = p_tx_id;
  get diagnostics n = row_count;
  if n <> 1 then
    return jsonb_build_object('status', 'busy');
  end if;
  return jsonb_build_object('status', 'done', 'tx', private.bot_tx_json(v_user, p_tx_id));
end;
$$;

-- 权限：只有 service_role 能执行
revoke all on function svc.svc_otp_reserve(text)                        from public, anon, authenticated;
revoke all on function svc.svc_otp_release(bigint)                      from public, anon, authenticated;
revoke all on function svc.svc_register_check(text, text, boolean)      from public, anon, authenticated;
revoke all on function svc.svc_redeem_invite(text, text)                from public, anon, authenticated;
revoke all on function svc.svc_refund_invite(text, text)                from public, anon, authenticated;
revoke all on function svc.svc_record_invite_use(text, text, uuid)      from public, anon, authenticated;
revoke all on function svc.svc_new_invite_code(integer, integer, text)  from public, anon, authenticated;
revoke all on function svc.svc_is_owner(text)                          from public, anon, authenticated;
revoke all on function svc.svc_invites_list()                          from public, anon, authenticated;
revoke all on function svc.svc_invite_set_active(text, boolean)        from public, anon, authenticated;
revoke all on function svc.svc_invite_uses(text)                       from public, anon, authenticated;
revoke all on function svc.svc_delete_user_data(uuid)                  from public, anon, authenticated;
revoke all on function svc.svc_tg_link_get(bigint)                     from public, anon, authenticated;
revoke all on function svc.svc_tg_bind(bigint, uuid, text)             from public, anon, authenticated;
revoke all on function svc.svc_tg_unlink(uuid)                         from public, anon, authenticated;
revoke all on function svc.svc_tg_status(uuid)                         from public, anon, authenticated;
revoke all on function svc.svc_tg_touch(bigint, text)                  from public, anon, authenticated;
revoke all on function svc.svc_tg_notify_reserve(bigint, uuid)         from public, anon, authenticated;
revoke all on function svc.svc_tg_notify_release(bigint, bigint)       from public, anon, authenticated;
revoke all on function svc.svc_bot_claim(bigint, bigint) from public, anon, authenticated;
revoke all on function svc.svc_bot_replied(bigint, bigint) from public, anon, authenticated;
revoke all on function svc.svc_bot_finish(bigint, bigint) from public, anon, authenticated;
revoke all on function svc.svc_bot_ai_consent(bigint) from public, anon, authenticated;
revoke all on function svc.svc_bot_ai_reserve(bigint, integer, integer) from public, anon, authenticated;
revoke all on function svc.svc_bot_ai_refund(bigint, bigint) from public, anon, authenticated;
revoke all on function svc.svc_bot_ai_count() from public, anon, authenticated;
revoke all on function svc.svc_bot_categories(bigint) from public, anon, authenticated;
revoke all on function svc.svc_bot_record(bigint, bigint, text, bigint, text, date, text, boolean) from public, anon, authenticated;
revoke all on function svc.svc_bot_confirm(bigint, uuid) from public, anon, authenticated;
revoke all on function svc.svc_bot_discard(bigint, uuid) from public, anon, authenticated;
revoke all on function svc.svc_bot_tx(bigint, uuid) from public, anon, authenticated;
revoke all on function svc.svc_bot_undo(bigint, uuid) from public, anon, authenticated;
revoke all on function svc.svc_bot_set_category(bigint, uuid, text, text) from public, anon, authenticated;
grant execute on function svc.svc_otp_reserve(text)                       to service_role;
grant execute on function svc.svc_otp_release(bigint)                     to service_role;
grant execute on function svc.svc_register_check(text, text, boolean)     to service_role;
grant execute on function svc.svc_redeem_invite(text, text)               to service_role;
grant execute on function svc.svc_refund_invite(text, text)               to service_role;
grant execute on function svc.svc_record_invite_use(text, text, uuid)     to service_role;
grant execute on function svc.svc_new_invite_code(integer, integer, text) to service_role;
grant execute on function svc.svc_is_owner(text)                         to service_role;
grant execute on function svc.svc_invites_list()                         to service_role;
grant execute on function svc.svc_invite_set_active(text, boolean)       to service_role;
grant execute on function svc.svc_invite_uses(text)                      to service_role;
grant execute on function svc.svc_delete_user_data(uuid)                 to service_role;
grant execute on function svc.svc_tg_link_get(bigint)                    to service_role;
grant execute on function svc.svc_tg_bind(bigint, uuid, text)            to service_role;
grant execute on function svc.svc_tg_unlink(uuid)                        to service_role;
grant execute on function svc.svc_tg_status(uuid)                        to service_role;
grant execute on function svc.svc_tg_touch(bigint, text)                 to service_role;
grant execute on function svc.svc_tg_notify_reserve(bigint, uuid)        to service_role;
grant execute on function svc.svc_tg_notify_release(bigint, bigint)      to service_role;
grant execute on function svc.svc_bot_claim(bigint, bigint) to service_role;
grant execute on function svc.svc_bot_replied(bigint, bigint) to service_role;
grant execute on function svc.svc_bot_finish(bigint, bigint) to service_role;
grant execute on function svc.svc_bot_ai_consent(bigint) to service_role;
grant execute on function svc.svc_bot_ai_reserve(bigint, integer, integer) to service_role;
grant execute on function svc.svc_bot_ai_refund(bigint, bigint) to service_role;
grant execute on function svc.svc_bot_ai_count() to service_role;
grant execute on function svc.svc_bot_categories(bigint) to service_role;
grant execute on function svc.svc_bot_record(bigint, bigint, text, bigint, text, date, text, boolean) to service_role;
grant execute on function svc.svc_bot_confirm(bigint, uuid) to service_role;
grant execute on function svc.svc_bot_discard(bigint, uuid) to service_role;
grant execute on function svc.svc_bot_tx(bigint, uuid) to service_role;
grant execute on function svc.svc_bot_undo(bigint, uuid) to service_role;
grant execute on function svc.svc_bot_set_category(bigint, uuid, text, text) to service_role;

-- 兜底：svc 里「所有」函数（包括以后新增、忘了写进上面名单的）一律只给 service_role
do $$
declare
  f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'svc' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;
-- 兜底：private 里的函数（bot 小工具等）一律不给 public／anon／authenticated（private 本来就不开放，多一层）
do $$
declare
  f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'private' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end
$$;
-- 注意：Postgres 新建函数默认开放给 public，而且无法只针对 svc 改掉这个默认。
--       所以在 svc 新增函数后，一定要重跑本文件，再跑 verify-2b（第 39 项会抓漏）与 verify-2f。

-- 请 API 重新读一次函数清单（函数参数改过时需要；重复通知无害）
notify pgrst, 'reload schema';

commit;
