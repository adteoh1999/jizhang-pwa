-- 记账 App · 2e 验收脚本（上传用的 upsert 在服务器上的行为）
-- 用法：supabase db query --remote -f supabase/sql/verify-2e.sql --yes（或贴到 SQL Editor 按 Run）。
-- 结果：一定会出现一个「错误」，内容是 VERIFY 2e: 通过数 / 总数 PASS。
--       这是故意的：用错误结束，脚本里建的临时用户与测试资料会全部自动撤回，不留垃圾。
-- 模拟 App 的上传：insert … on conflict (user_id, id) do update … returning id, updated_at
-- （PostgREST 的 Prefer: resolution=merge-duplicates,return=representation 就是这样）

do $$
declare
  a  uuid := '00000000-0000-4000-8000-0000000002ea';
  b  uuid := '00000000-0000-4000-8000-0000000002eb';
  t1 uuid := '00000000-0000-4000-8000-0000000002e1';
  t2 uuid := '00000000-0000-4000-8000-0000000002e2';
  pass  int := 0;
  total int := 0;
  fails text[] := '{}';
  n   int;
  ts  timestamptz;
  ts0 timestamptz := date_trunc('milliseconds', now()) - interval '1 hour';
  rid uuid;
  rts timestamptz;
  uid uuid;
  amt bigint;
begin
  insert into auth.users (instance_id, id, aud, role, email)
  values ('00000000-0000-0000-0000-000000000000', a, 'authenticated', 'authenticated', 'a2e@test.invalid'),
         ('00000000-0000-0000-0000-000000000000', b, 'authenticated', 'authenticated', 'b2e@test.invalid');

  -- ===================== 身份：A =====================
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  -- 1. A upsert 新增 → 回 1 列、user_id = A
  total := total + 1;
  begin
    insert into public.transactions as t (id, kind, amount_minor, category_id, occurred_on, note, created_at, updated_at, deleted)
    values (t1, 'expense', 100, 'food', '2026-11-25', '', ts0, ts0, false)
    on conflict (user_id, id) do update set kind = excluded.kind, amount_minor = excluded.amount_minor,
      category_id = excluded.category_id, occurred_on = excluded.occurred_on, note = excluded.note,
      created_at = excluded.created_at, updated_at = excluded.updated_at, deleted = excluded.deleted
    returning t.id, t.updated_at into rid, rts;
    select user_id into uid from public.transactions where id = t1;
    if rid = t1 and rts = ts0 and uid = a then pass := pass + 1;
    else fails := array_append(fails, format('1.新增 rid=%s uid=%s', rid, uid)); end if;
  exception when others then fails := array_append(fails, '1.新增失败:' || sqlerrm);
  end;

  -- 2. 较旧的 updated_at 再 upsert 同一笔 → 回 0 列、资料不变
  total := total + 1;
  begin
    with up as (
      insert into public.transactions as t (id, kind, amount_minor, category_id, occurred_on, note, created_at, updated_at, deleted)
      values (t1, 'expense', 999, 'food', '2026-11-25', '', ts0, ts0 - interval '2 days', false)
      on conflict (user_id, id) do update set amount_minor = excluded.amount_minor, updated_at = excluded.updated_at
      returning t.id)
    select count(*) into n from up;
    select amount_minor into amt from public.transactions where id = t1;
    if n = 0 and amt = 100 then pass := pass + 1; else fails := array_append(fails, format('2.较旧 回%s列 金额%s', n, amt)); end if;
  exception when others then fails := array_append(fails, '2.较旧失败:' || sqlerrm);
  end;

  -- 3. updated_at 完全相同再 upsert → 0 列（同内容重传是幂等的）
  total := total + 1;
  begin
    with up as (
      insert into public.transactions as t (id, kind, amount_minor, category_id, occurred_on, note, created_at, updated_at, deleted)
      values (t1, 'expense', 555, 'food', '2026-11-25', '', ts0, ts0, false)
      on conflict (user_id, id) do update set amount_minor = excluded.amount_minor, updated_at = excluded.updated_at
      returning t.id)
    select count(*) into n from up;
    select amount_minor into amt from public.transactions where id = t1;
    if n = 0 and amt = 100 then pass := pass + 1; else fails := array_append(fails, format('3.相同时间 回%s列 金额%s', n, amt)); end if;
  exception when others then fails := array_append(fails, '3.相同时间失败:' || sqlerrm);
  end;

  -- 4. 快 1 天的 updated_at → 存进去约等于 now()，returning 回的就是存进去的值
  total := total + 1;
  begin
    insert into public.transactions as t (id, kind, amount_minor, category_id, occurred_on, note, created_at, updated_at, deleted)
    values (t2, 'expense', 200, 'food', '2026-11-25', '', ts0, now() + interval '1 day', false)
    on conflict (user_id, id) do update set updated_at = excluded.updated_at
    returning t.updated_at into rts;
    select updated_at into ts from public.transactions where id = t2;
    if rts = ts and ts <= now() + interval '1 second' and ts >= now() - interval '1 minute' then pass := pass + 1;
    else fails := array_append(fails, format('4.时钟快 回%s 存%s', rts, ts)); end if;
  exception when others then fails := array_append(fails, '4.时钟快失败:' || sqlerrm);
  end;

  -- 5. 较新的 updated_at → 更新成功、回 1 列
  total := total + 1;
  begin
    with up as (
      insert into public.transactions as t (id, kind, amount_minor, category_id, occurred_on, note, created_at, updated_at, deleted)
      values (t1, 'expense', 300, 'food', '2026-11-25', '', ts0, ts0 + interval '1 minute', true)
      on conflict (user_id, id) do update set amount_minor = excluded.amount_minor, updated_at = excluded.updated_at, deleted = excluded.deleted
      returning t.id)
    select count(*) into n from up;
    select amount_minor into amt from public.transactions where id = t1 and deleted;
    if n = 1 and amt = 300 then pass := pass + 1; else fails := array_append(fails, format('5.较新 回%s列 金额%s', n, amt)); end if;
  exception when others then fails := array_append(fails, '5.较新失败:' || sqlerrm);
  end;

  -- 6. A 不能 delete（一律用 deleted 标记）
  total := total + 1;
  begin
    delete from public.transactions where id = t1;
    fails := array_append(fails, '6.A竟然能删除');
  exception when insufficient_privilege then pass := pass + 1;
    when others then fails := array_append(fails, '6.删除错误不对:' || sqlerrm);
  end;

  -- 7. 坏资料：金额 0 → 23514（App 会标「无法同步」）
  total := total + 1;
  begin
    insert into public.transactions (id, kind, amount_minor, category_id, occurred_on, note, created_at, updated_at, deleted)
    values (gen_random_uuid(), 'expense', 0, 'food', '2026-11-25', '', ts0, ts0, false);
    fails := array_append(fails, '7.金额0竟然成功');
  exception when check_violation then pass := pass + 1;
    when others then fails := array_append(fails, '7.错误码不对:' || sqlstate);
  end;

  -- ===================== 身份：B =====================
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);

  -- 8. B 查不到 A 的列
  total := total + 1;
  select count(*) into n from public.transactions where id in (t1, t2);
  if n = 0 then pass := pass + 1; else fails := array_append(fails, format('8.B看到A的%s列', n)); end if;

  -- 9. B 带 user_id = A 新增 → 被 RLS 挡
  total := total + 1;
  begin
    insert into public.transactions (user_id, id, kind, amount_minor, category_id, occurred_on, note, created_at, updated_at, deleted)
    values (a, gen_random_uuid(), 'expense', 1, 'food', '2026-11-25', '', ts0, ts0, false);
    fails := array_append(fails, '9.B竟然能写进A');
  exception when insufficient_privilege then pass := pass + 1;
    when others then fails := array_append(fails, '9.错误不对:' || sqlerrm);
  end;

  -- 10. B 用同一个 id upsert 自己的列 → 成功（主键是 user_id, id），不动到 A 的
  total := total + 1;
  begin
    insert into public.transactions as t (id, kind, amount_minor, category_id, occurred_on, note, created_at, updated_at, deleted)
    values (t1, 'income', 777, 'salary', '2026-11-25', '', ts0, ts0 + interval '1 hour', false)
    on conflict (user_id, id) do update set amount_minor = excluded.amount_minor, updated_at = excluded.updated_at
    returning t.user_id into uid;
    perform set_config('role', 'postgres', true);
    select amount_minor into amt from public.transactions where id = t1 and user_id = a;
    perform set_config('role', 'authenticated', true);
    if uid = b and amt = 300 then pass := pass + 1; else fails := array_append(fails, format('10.同id uid=%s A金额=%s', uid, amt)); end if;
  exception when others then fails := array_append(fails, '10.同id失败:' || sqlerrm);
  end;

  -- 11. 分类：默认分类用 epoch 时间上传 → 成功；再传一次 → 0 列
  total := total + 1;
  begin
    insert into public.categories as c (id, kind, name, icon, sort, updated_at, deleted)
    values ('food', 'expense', '餐饮', 'food', 0, 'epoch', false)
    on conflict (user_id, id) do update set name = excluded.name, updated_at = excluded.updated_at;
    with up as (
      insert into public.categories as c (id, kind, name, icon, sort, updated_at, deleted)
      values ('food', 'expense', '餐饮', 'food', 0, 'epoch', false)
      on conflict (user_id, id) do update set name = excluded.name, updated_at = excluded.updated_at
      returning c.id)
    select count(*) into n from up;
    if n = 0 then pass := pass + 1; else fails := array_append(fails, format('11.分类重传回%s列', n)); end if;
  exception when others then fails := array_append(fails, '11.分类失败:' || sqlerrm);
  end;

  raise exception 'VERIFY 2e: % / % PASS。失败: %', pass, total,
    case when cardinality(fails) = 0 then '无' else array_to_string(fails, '；') end;
end
$$;
