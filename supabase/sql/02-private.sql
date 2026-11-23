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

-- 注册尝试（按 IP），防止猜邀请码；只留 2 天
create table if not exists private.register_attempts (
  id  bigserial   primary key,
  key text        not null,
  at  timestamptz not null default now()
);
create index if not exists register_attempts_key_idx on private.register_attempts (key, at);

-- 第 3 阶段 Telegram 用（先建，栏位未定案）
create table if not exists private.telegram_links (
  telegram_id      bigint      primary key,
  user_id          uuid        not null unique references auth.users (id) on delete cascade,
  kind             text        not null check (kind in ('telegram', 'email')),
  previous_user_id uuid,
  linked_at        timestamptz not null default now()
);

-- 多一层防线：开 RLS、不建 policy（definer 函数不受影响）
alter table private.owner_emails      enable row level security;
alter table private.otp_sends         enable row level security;
alter table private.otp_locks         enable row level security;
alter table private.invite_codes      enable row level security;
alter table private.invite_uses       enable row level security;
alter table private.register_attempts enable row level security;
alter table private.telegram_links    enable row level security;

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

-- 注册前的检查：IP 是否太多次、邮箱是否已有账号、是不是站主
-- p_ip 为 null 或空字串：不记、不限流
create or replace function svc.svc_register_check(p_email text, p_ip text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  e       text    := lower(btrim(coalesce(p_email, '')));
  limited boolean := false;
  n       integer;
begin
  delete from private.register_attempts where at < now() - interval '2 days';
  if p_ip is not null and p_ip <> '' then
    select count(*) into n from private.register_attempts where key = 'ip:' || p_ip and at > now() - interval '1 hour';
    if n >= 20 then
      limited := true;
    else
      insert into private.register_attempts (key) values ('ip:' || p_ip);
    end if;
  end if;
  return jsonb_build_object(
    'limited', limited,
    'exists',  exists (select 1 from auth.users u where lower(u.email) = e),
    'owner',   exists (select 1 from private.owner_emails o where o.email = e)
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

-- 产生新邀请码，回传 8 个字（不加连字号）
create or replace function svc.svc_new_invite_code(p_max_uses integer default 1, p_days integer default 7, p_note text default '')
returns text
language plpgsql security definer set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';  -- 31 个字
  v_code text;
  b      bytea;
  x      integer;
begin
  if p_max_uses is null or p_max_uses < 1 or p_days is null or p_days < 1 then
    raise exception '可用次数和天数都要至少 1';
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
        values (v_code, p_max_uses, now() + make_interval(days => p_days), coalesce(p_note, ''));
      return v_code;
    exception when unique_violation then
      null;  -- 撞到旧码，重抽
    end;
  end loop;
end;
$$;

-- 权限：只有 service_role 能执行
revoke all on function svc.svc_otp_reserve(text)                        from public, anon, authenticated;
revoke all on function svc.svc_otp_release(bigint)                      from public, anon, authenticated;
revoke all on function svc.svc_register_check(text, text)               from public, anon, authenticated;
revoke all on function svc.svc_redeem_invite(text, text)                from public, anon, authenticated;
revoke all on function svc.svc_refund_invite(text, text)                from public, anon, authenticated;
revoke all on function svc.svc_record_invite_use(text, text, uuid)      from public, anon, authenticated;
revoke all on function svc.svc_new_invite_code(integer, integer, text)  from public, anon, authenticated;
grant execute on function svc.svc_otp_reserve(text)                       to service_role;
grant execute on function svc.svc_otp_release(bigint)                     to service_role;
grant execute on function svc.svc_register_check(text, text)              to service_role;
grant execute on function svc.svc_redeem_invite(text, text)               to service_role;
grant execute on function svc.svc_refund_invite(text, text)               to service_role;
grant execute on function svc.svc_record_invite_use(text, text, uuid)     to service_role;
grant execute on function svc.svc_new_invite_code(integer, integer, text) to service_role;

commit;
