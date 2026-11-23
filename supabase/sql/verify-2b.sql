-- 记账 App · 2b 验收脚本
-- 用法：在 Supabase SQL Editor 贴上整个文件，按 Run。
-- 结果：一定会出现一个「红色错误」，内容是 VERIFY 2b: 通过数 / 总数 PASS。
--       这是故意的：用错误结束，脚本里建的测试资料会全部自动撤回，不留垃圾。
--       看到「失败:」后面有项目名称，就把整段讯息贴给 Claude。
--       如果红字开头**不是** VERIFY 2b（例如 permission denied、syntax error），也请整段贴回来。

do $$
declare
  a  uuid := '00000000-0000-4000-8000-00000000000a';
  b  uuid := '00000000-0000-4000-8000-00000000000b';
  t1 uuid := '00000000-0000-4000-8000-0000000000f1';
  t2 uuid := '00000000-0000-4000-8000-0000000000f2';
  pass  int := 0;
  total int := 0;
  fails text[] := '{}';
  n   int;
  ok  boolean;
  v   text;
  ts  timestamptz;
  uid uuid;
begin
  -- 两个临时测试用户（脚本结束时会被撤回）
  insert into auth.users (instance_id, id, aud, role, email)
  values ('00000000-0000-0000-0000-000000000000', a, 'authenticated', 'authenticated', 'a@test.invalid'),
         ('00000000-0000-0000-0000-000000000000', b, 'authenticated', 'authenticated', 'b@test.invalid');

  -- ===================== 身份：A =====================
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  -- 1. A 新增一笔账（一小时前改的），没给 source
  total := total + 1;
  begin
    insert into public.transactions (id, kind, amount_minor, category_id, occurred_on, note, created_at, updated_at)
    values (t1, 'expense', 690, 'food', '2026-11-23', '早餐', now() - interval '1 hour', now() - interval '1 hour');
    select count(*) into n from public.transactions where id = t1;
    if n = 1 then pass := pass + 1; else fails := array_append(fails, 'A新增后读不到'::text); end if;
  exception when others then fails := array_append(fails, ('A新增失败:' || sqlerrm));
  end;

  -- 2. 没给 source → manual
  total := total + 1;
  select source into v from public.transactions where id = t1;
  if v = 'manual' then pass := pass + 1; else fails := array_append(fails, ('source默认值=' || coalesce(v, 'null'))); end if;

  -- 3. A 删除自己的账 → 没有权限（一律标记删除）
  total := total + 1;
  begin
    delete from public.transactions where id = t1;
    fails := array_append(fails, 'A竟然能delete'::text);
  exception when insufficient_privilege then pass := pass + 1;
  end;

  -- 4. 用比较旧的时间更新 → 被略过，内容不变
  total := total + 1;
  update public.transactions set note = '旧资料', updated_at = now() - interval '2 hours' where id = t1;
  select note into v from public.transactions where id = t1;
  if v = '早餐' then pass := pass + 1; else fails := array_append(fails, '旧资料盖掉新资料'::text); end if;

  -- 5. 手机时钟快一天 → 存进去的时间被压回现在
  total := total + 1;
  update public.transactions set note = '未来', updated_at = now() + interval '1 day' where id = t1;
  select note, updated_at into v, ts from public.transactions where id = t1;
  if v = '未来' and ts <= now() + interval '5 seconds' then pass := pass + 1;
  else fails := array_append(fails, ('未来时间没压回:' || coalesce(ts::text, 'null'))); end if;

  -- 6. 压回之后，别的设备用正常时间还能再改
  total := total + 1;
  update public.transactions set note = '之后再改', updated_at = now() + interval '1 second' where id = t1;
  select note into v from public.transactions where id = t1;
  if v = '之后再改' then pass := pass + 1; else fails := array_append(fails, '压回后改不了'::text); end if;

  -- 7. 想把账改到 B 名下 → user_id 不变
  total := total + 1;
  begin
    update public.transactions set user_id = b, updated_at = now() + interval '2 seconds' where id = t1;
  exception when others then null;
  end;
  select user_id into uid from public.transactions where id = t1;
  if uid = a then pass := pass + 1; else fails := array_append(fails, 'user_id被改走'::text); end if;

  -- 8. update 时送 source → 保持原值
  total := total + 1;
  update public.transactions set source = 'import', updated_at = now() + interval '3 seconds' where id = t1;
  select source into v from public.transactions where id = t1;
  if v = 'manual' then pass := pass + 1; else fails := array_append(fails, ('update改了source=' || coalesce(v, 'null'))); end if;

  -- 9. insert 时 source 明确给 null → 补成 manual
  total := total + 1;
  begin
    insert into public.transactions (id, kind, amount_minor, category_id, occurred_on, source, created_at, updated_at)
    values (t2, 'income', 300000, 'salary', '2026-11-23', null, now(), now());
    select source into v from public.transactions where id = t2;
    if v = 'manual' then pass := pass + 1; else fails := array_append(fails, ('null的source=' || coalesce(v, 'null'))); end if;
  exception when others then fails := array_append(fails, ('source为null时insert失败:' || sqlerrm));
  end;

  -- 10. source 不在名单内 → 拒绝
  total := total + 1;
  begin
    insert into public.transactions (id, kind, amount_minor, category_id, occurred_on, source, created_at, updated_at)
    values (gen_random_uuid(), 'expense', 100, 'food', '2026-11-23', 'xyz', now(), now());
    fails := array_append(fails, 'source=xyz竟然能存'::text);
  exception when check_violation then pass := pass + 1;
  end;

  -- 11. 备注 501 字 → 拒绝
  total := total + 1;
  begin
    insert into public.transactions (id, kind, amount_minor, category_id, occurred_on, note, created_at, updated_at)
    values (gen_random_uuid(), 'expense', 100, 'food', '2026-11-23', repeat('字', 501), now(), now());
    fails := array_append(fails, '501字备注竟然能存'::text);
  exception when check_violation then pass := pass + 1;
  end;

  -- 12. 金额超过上限 RM 99,999,999.99 → 拒绝
  total := total + 1;
  begin
    insert into public.transactions (id, kind, amount_minor, category_id, occurred_on, created_at, updated_at)
    values (gen_random_uuid(), 'expense', 10000000000, 'food', '2026-11-23', now(), now());
    fails := array_append(fails, '超额金额竟然能存'::text);
  exception when check_violation then pass := pass + 1;
  end;

  -- 13. A 新增分类 food、关键词 grab
  total := total + 1;
  begin
    insert into public.categories (id, kind, name, icon, sort, updated_at) values ('food', 'expense', '餐饮', 'food', 0, now());
    insert into public.category_keywords (keyword, category_id, updated_at) values ('grab', 'transport', now());
    pass := pass + 1;
  exception when others then fails := array_append(fails, ('A新增分类或关键词失败:' || sqlerrm));
  end;

  -- 14. 关键词没先转小写、去空白 → 拒绝
  total := total + 1;
  begin
    insert into public.category_keywords (keyword, category_id, updated_at) values ('Grab', 'transport', now());
    fails := array_append(fails, '大写关键词竟然能存'::text);
  exception when check_violation then pass := pass + 1;
  end;

  -- 15. 同一个关键词再加一次（较新）→ 只有一列，分类变新的
  total := total + 1;
  begin
    insert into public.category_keywords (keyword, category_id, updated_at) values ('grab', 'other', now() + interval '1 second')
    on conflict (user_id, keyword) do update set category_id = excluded.category_id, updated_at = excluded.updated_at;
    select count(*), max(category_id) into n, v from public.category_keywords where keyword = 'grab';
    if n = 1 and v = 'other' then pass := pass + 1; else fails := array_append(fails, '关键词重复或没更新'::text); end if;
  exception when others then fails := array_append(fails, ('关键词upsert失败:' || sqlerrm));
  end;

  -- 16. A 删除分类、关键词 → 没有权限
  total := total + 1;
  begin
    delete from public.categories where id = 'food';
    fails := array_append(fails, 'A竟然能delete分类'::text);
  exception when insufficient_privilege then pass := pass + 1;
  end;
  total := total + 1;
  begin
    delete from public.category_keywords where keyword = 'grab';
    fails := array_append(fails, 'A竟然能delete关键词'::text);
  exception when insufficient_privilege then pass := pass + 1;
  end;

  -- 17. 关键词前面带空格 → 拒绝
  total := total + 1;
  begin
    insert into public.category_keywords (keyword, category_id, updated_at) values (' grab', 'transport', now());
    fails := array_append(fails, '带空格的关键词竟然能存'::text);
  exception when check_violation then pass := pass + 1;
  end;

  -- 18. 关键词标记删除后再加回 → 取消删除
  total := total + 1;
  update public.category_keywords set deleted = true, updated_at = now() + interval '2 seconds' where keyword = 'grab';
  insert into public.category_keywords (keyword, category_id, deleted, updated_at) values ('grab', 'transport', false, now() + interval '3 seconds')
  on conflict (user_id, keyword) do update set category_id = excluded.category_id, deleted = excluded.deleted, updated_at = excluded.updated_at;
  select count(*) into n from public.category_keywords where keyword = 'grab' and not deleted;
  if n = 1 then pass := pass + 1; else fails := array_append(fails, '关键词删除后加不回来'::text); end if;

  -- ===================== 身份：B =====================
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);

  -- 19. B 看不到 A 的账、分类、关键词
  total := total + 1;
  select (select count(*) from public.transactions) + (select count(*) from public.categories)
       + (select count(*) from public.category_keywords) into n;
  if n = 0 then pass := pass + 1; else fails := array_append(fails, ('B看得到A的资料:' || n)); end if;

  -- 20. B 改 A 的账 → 影响 0 列
  total := total + 1;
  update public.transactions set note = 'B改的', updated_at = now() + interval '1 hour' where id = t1;
  get diagnostics n = row_count;
  if n = 0 then pass := pass + 1; else fails := array_append(fails, 'B改得到A的账'::text); end if;

  -- 21. B 冒用 A 的 user_id 新增 → 拒绝
  total := total + 1;
  begin
    insert into public.transactions (user_id, id, kind, amount_minor, category_id, occurred_on, created_at, updated_at)
    values (a, gen_random_uuid(), 'expense', 100, 'food', '2026-11-23', now(), now());
    fails := array_append(fails, 'B能冒用A新增'::text);
  exception when insufficient_privilege then pass := pass + 1;
  end;

  -- 22. B 也有自己的 food 分类和 grab 关键词（每人各一套）
  total := total + 1;
  begin
    insert into public.categories (id, kind, name, icon, sort, updated_at) values ('food', 'expense', '吃饭', 'food', 0, now());
    insert into public.category_keywords (keyword, category_id, updated_at) values ('grab', 'transport', now());
    pass := pass + 1;
  exception when others then fails := array_append(fails, ('B建不了自己的分类或关键词:' || sqlerrm));
  end;

  -- ===================== 身份：未登录（anon）=====================
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('role', 'anon', true);

  -- 23. 未登录读任何一张表 → 没有权限
  total := total + 1;
  ok := true;
  begin select count(*) into n from public.transactions; ok := false; exception when insufficient_privilege then null; end;
  begin select count(*) into n from public.categories; ok := false; exception when insufficient_privilege then null; end;
  begin select count(*) into n from public.category_keywords; ok := false; exception when insufficient_privilege then null; end;
  if ok then pass := pass + 1; else fails := array_append(fails, '未登录读得到资料表'::text); end if;

  -- 24. 未登录新增 → 没有权限
  total := total + 1;
  begin
    insert into public.transactions (user_id, id, kind, amount_minor, category_id, occurred_on, created_at, updated_at)
    values (a, gen_random_uuid(), 'expense', 100, 'food', '2026-11-23', now(), now());
    fails := array_append(fails, '未登录能新增'::text);
  exception when insufficient_privilege then pass := pass + 1;
  end;

  -- ===== 2b-2 的检查会加在这一行下面 =====

  raise exception 'VERIFY 2b: % / % PASS。失败: %', pass, total,
    case when cardinality(fails) = 0 then '无' else array_to_string(fails, '；') end;
end
$$;
