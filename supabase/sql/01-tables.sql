-- 记账 App · 2b-1 资料表、权限、RLS、「最后修改者胜」trigger
-- 用法：在 Supabase SQL Editor 贴上整个文件，按 Run。可以重复执行（不会重复建、不会报错）。
-- 说明：后台「新表自动开放给 API」是关的，所以这里自己写清楚谁能做什么。

begin;

-- ---------- 1. 资料表 ----------
-- 共通栏位：user_id（谁的）、updated_at（客户端最后修改时间）、deleted（标记删除）、
--           server_updated_at（服务器写入时间，同步拉取的游标，由 trigger 设定）

create table if not exists public.transactions (
  user_id           uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id                uuid        primary key,
  kind              text        not null check (kind in ('expense', 'income')),
  amount_minor      bigint      not null check (amount_minor between 1 and 9999999999),  -- 「仙」，上限 RM 99,999,999.99
  category_id       text        not null check (char_length(category_id) between 1 and 64),
  occurred_on       date        not null,
  note              text        not null default '' check (char_length(note) <= 500),
  created_at        timestamptz not null,
  source            text        not null default 'manual' check (source in ('manual', 'bot', 'import')),
  updated_at        timestamptz not null,
  deleted           boolean     not null default false,
  server_updated_at timestamptz not null default now()
);

create table if not exists public.categories (
  user_id           uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id                text        not null check (char_length(id) between 1 and 64),
  kind              text        not null check (kind in ('expense', 'income')),
  name              text        not null check (char_length(name) between 1 and 30),
  icon              text        not null default '' check (char_length(icon) <= 30),
  sort              integer     not null default 0,
  updated_at        timestamptz not null,
  deleted           boolean     not null default false,
  server_updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- 第 3 阶段 Telegram bot 用的关键词对照（用户自己加的）。关键词本身就是主键：
-- 两台设备各加同一个关键词 = 同一列，照「最后修改者胜」合并；删了再加 = 取消删除。
create table if not exists public.category_keywords (
  user_id           uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  keyword           text        not null check (keyword = lower(btrim(keyword)) and char_length(keyword) between 1 and 20),
  category_id       text        not null check (char_length(category_id) between 1 and 64),
  updated_at        timestamptz not null,
  deleted           boolean     not null default false,
  server_updated_at timestamptz not null default now(),
  primary key (user_id, keyword)
);

-- 同步拉取用：按「谁的、服务器时间」找新改过的列
create index if not exists transactions_sync_idx      on public.transactions      (user_id, server_updated_at);
create index if not exists categories_sync_idx        on public.categories        (user_id, server_updated_at);
create index if not exists category_keywords_sync_idx on public.category_keywords (user_id, server_updated_at);

-- ---------- 2. 权限：登录的人可读、可新增、可修改；不能删除；未登录什么都不行 ----------
revoke all on public.transactions, public.categories, public.category_keywords from public, anon, authenticated;
grant select, insert, update on public.transactions, public.categories, public.category_keywords to authenticated;
grant select, insert, update on public.transactions, public.categories, public.category_keywords to service_role;

-- ---------- 3. RLS：每个人只能碰自己的列 ----------
alter table public.transactions      enable row level security;
alter table public.categories        enable row level security;
alter table public.category_keywords enable row level security;

drop policy if exists own_select on public.transactions;
drop policy if exists own_insert on public.transactions;
drop policy if exists own_update on public.transactions;
create policy own_select on public.transactions for select to authenticated using (user_id = (select auth.uid()));
create policy own_insert on public.transactions for insert to authenticated with check (user_id = (select auth.uid()));
create policy own_update on public.transactions for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists own_select on public.categories;
drop policy if exists own_insert on public.categories;
drop policy if exists own_update on public.categories;
create policy own_select on public.categories for select to authenticated using (user_id = (select auth.uid()));
create policy own_insert on public.categories for insert to authenticated with check (user_id = (select auth.uid()));
create policy own_update on public.categories for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists own_select on public.category_keywords;
drop policy if exists own_insert on public.category_keywords;
drop policy if exists own_update on public.category_keywords;
create policy own_select on public.category_keywords for select to authenticated using (user_id = (select auth.uid()));
create policy own_insert on public.category_keywords for insert to authenticated with check (user_id = (select auth.uid()));
create policy own_update on public.category_keywords for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------- 4. 「最后修改者胜」trigger ----------
-- 1) 客户端时间比服务器快 5 分钟以上 → 压回现在（手机时钟错乱时，这笔之后还能被改）
-- 2) 修改时：客户端时间不比旧的新 → 静默略过（旧资料不盖新资料）
-- 3) 修改时：user_id 不能改；transactions 的 source 保持旧值
-- 4) 新增时：transactions 的 source 是 null 就补 'manual'
-- 5) 设定 server_updated_at（同步游标）
-- 注意：以后在后台手动修资料，也要把 updated_at 改大，否则会被第 2) 点静默略过。
create or replace function public.lww_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.updated_at > now() + interval '5 minutes' then
    new.updated_at := now();
  end if;

  if tg_op = 'UPDATE' then
    if new.updated_at <= old.updated_at then
      return null;
    end if;
    new.user_id := old.user_id;
    if tg_table_name = 'transactions' then
      new.source := old.source;
    end if;
  elsif tg_table_name = 'transactions' then
    new.source := coalesce(new.source, 'manual');
  end if;

  new.server_updated_at := clock_timestamp();
  return new;
end;
$$;

revoke all on function public.lww_guard() from public, anon, authenticated;

drop trigger if exists lww_guard on public.transactions;
drop trigger if exists lww_guard on public.categories;
drop trigger if exists lww_guard on public.category_keywords;
create trigger lww_guard before insert or update on public.transactions      for each row execute function public.lww_guard();
create trigger lww_guard before insert or update on public.categories        for each row execute function public.lww_guard();
create trigger lww_guard before insert or update on public.category_keywords for each row execute function public.lww_guard();

commit;
