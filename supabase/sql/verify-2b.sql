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
  ts2 timestamptz;
  n2  int;
  n3  int;
  ok2 boolean;
  ok3 boolean;
  r   jsonb;
  r2  jsonb;
  r3  jsonb;
  c1  text;
  c2  text;
  c3  text;
  c4  text;
  c5  text;
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

  -- ===================== 2b-2：内部表与 svc 函数 =====================
  -- 造测试资料用 postgres；调用函数用 service_role（Edge Function 就是这个身份）
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('role', 'service_role', true);

  -- 25. 同一邮箱连要两次 → 第 1 次 ok，第 2 次「秒后再试」
  total := total + 1;
  r := svc.svc_otp_reserve('me@test.invalid');
  r2 := svc.svc_otp_reserve('me@test.invalid');
  if (r->>'ok')::boolean and not (r2->>'ok')::boolean and r2->>'message' like '%秒后再试%' then pass := pass + 1;
  else fails := array_append(fails, ('60秒规则:' || r::text || r2::text)); end if;

  -- 26. 大小写、前后空白不同 → 当成同一人
  total := total + 1;
  r := svc.svc_otp_reserve(' Me@Test.Invalid ');
  if not (r->>'ok')::boolean and r->>'message' like '%秒后再试%' then pass := pass + 1;
  else fails := array_append(fails, ('邮箱没正规化:' || r::text)); end if;

  -- 27. 一小时内已 5 次 → 被拒并上锁 1 小时；再试 → 锁没变长
  perform set_config('role', 'postgres', true);
  insert into private.otp_sends (email, sent_at) select 'h@test.invalid', now() - (m || ' minutes')::interval
    from unnest(array[2, 10, 20, 30, 59]) m;
  perform set_config('role', 'service_role', true);
  total := total + 1;
  r := svc.svc_otp_reserve('h@test.invalid');
  perform set_config('role', 'postgres', true);
  select locked_until into ts from private.otp_locks where email = 'h@test.invalid';
  perform set_config('role', 'service_role', true);
  r2 := svc.svc_otp_reserve('h@test.invalid');
  perform set_config('role', 'postgres', true);
  select locked_until into ts2 from private.otp_locks where email = 'h@test.invalid';
  if not (r->>'ok')::boolean and r->>'message' like '%60 分钟%'
     and ts = now() + interval '1 hour' and ts2 = ts and not (r2->>'ok')::boolean and r2->>'message' like '%60 分钟%' then pass := pass + 1;
  else fails := array_append(fails, ('每小时5次/锁:' || r::text || coalesce(ts::text, 'null'))); end if;

  -- 27b. 一小时内只有 4 次 → 仍可寄（差一个不算超过）
  perform set_config('role', 'postgres', true);
  insert into private.otp_sends (email, sent_at) select 'h4@test.invalid', now() - (m || ' minutes')::interval
    from unnest(array[2, 10, 20, 59]) m;
  perform set_config('role', 'service_role', true);
  total := total + 1;
  r := svc.svc_otp_reserve('h4@test.invalid');
  if (r->>'ok')::boolean then pass := pass + 1; else fails := array_append(fails, ('一小时4次被拒:' || r::text)); end if;

  -- 28. 同一邮箱 24 小时已 10 封 → 被拒
  perform set_config('role', 'postgres', true);
  insert into private.otp_sends (email, sent_at) select 'd@test.invalid', now() - (h || ' hours')::interval
    from generate_series(2, 11) h;
  perform set_config('role', 'service_role', true);
  total := total + 1;
  r := svc.svc_otp_reserve('d@test.invalid');
  if not (r->>'ok')::boolean and r->>'message' like '%这个邮箱%' then pass := pass + 1;
  else fails := array_append(fails, ('24小时10封:' || r::text)); end if;

  -- 29. 撤回之后，那次不算 → 马上可以再要
  total := total + 1;
  r := svc.svc_otp_reserve('r@test.invalid');
  perform svc.svc_otp_release((r->>'id')::bigint);
  r2 := svc.svc_otp_reserve('r@test.invalid');
  if (r->>'ok')::boolean and (r2->>'ok')::boolean then pass := pass + 1;
  else fails := array_append(fails, ('撤回无效:' || r::text || r2::text)); end if;

  -- 30. 今天（UTC）非站主已 70 封 → 非站主被拒；站主仍可寄
  perform set_config('role', 'postgres', true);
  insert into private.otp_sends (email, sent_at) select 'g' || i || '@test.invalid', now() from generate_series(1, 70) i;
  insert into private.owner_emails (email) values ('owner@test.invalid');
  perform set_config('role', 'service_role', true);
  total := total + 1;
  r := svc.svc_otp_reserve('x@test.invalid');
  r2 := svc.svc_otp_reserve('owner@test.invalid');
  if not (r->>'ok')::boolean and r->>'message' like '%今天的验证码已达上限%' and (r2->>'ok')::boolean then pass := pass + 1;
  else fails := array_append(fails, ('全站每日上限:' || r::text || r2::text)); end if;

  -- 30b. 站主今天已 10 封 → 站主也被拒
  perform set_config('role', 'postgres', true);
  insert into private.owner_emails (email) values ('owner2@test.invalid'), ('owner3@test.invalid');
  insert into private.otp_sends (email, sent_at) select 'owner2@test.invalid', now() from generate_series(1, 10);
  perform set_config('role', 'service_role', true);
  total := total + 1;
  r := svc.svc_otp_reserve('owner3@test.invalid');
  if not (r->>'ok')::boolean and r->>'message' like '%今天的验证码已达上限%' then pass := pass + 1;
  else fails := array_append(fails, ('站主每日10封:' || r::text)); end if;

  -- 31. 产生邀请码：8 个字，只用规定的字
  total := total + 1;
  c1 := svc.svc_new_invite_code();
  if c1 ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$' then pass := pass + 1;
  else fails := array_append(fails, ('邀请码格式:' || coalesce(c1, 'null'))); end if;

  -- 32. 扣码：X 用 → 成功；X 再用同一码 → 仍成功、不重复扣；Y 用 → 失败
  total := total + 1;
  ok := svc.svc_redeem_invite(c1, 'x1@test.invalid');
  ok2 := svc.svc_redeem_invite(c1, ' X1@Test.Invalid ');
  ok3 := svc.svc_redeem_invite(c1, 'y1@test.invalid');
  perform set_config('role', 'postgres', true);
  select used_count into n from private.invite_codes where code = c1;
  perform set_config('role', 'service_role', true);
  if ok and ok2 and not ok3 and n = 1 then pass := pass + 1;
  else fails := array_append(fails, format('扣码:%s/%s/%s 次数=%s', ok, ok2, ok3, n)); end if;

  -- 33. 退码后 Y 可以用；建好账号后保留变成已使用
  total := total + 1;
  perform svc.svc_refund_invite(c1, 'x1@test.invalid');
  ok := svc.svc_redeem_invite(c1, 'y1@test.invalid');
  perform svc.svc_record_invite_use(c1, 'y1@test.invalid', a);
  perform set_config('role', 'postgres', true);
  select used_count into n from private.invite_codes where code = c1;
  select count(*) into n2 from private.invite_uses where code = c1 and email = 'y1@test.invalid' and status = 'used' and user_id = a;
  select count(*) into n3 from private.invite_uses where code = c1 and email = 'x1@test.invalid';
  perform set_config('role', 'service_role', true);
  if ok and n = 1 and n2 = 1 and n3 = 0 then pass := pass + 1;
  else fails := array_append(fails, format('退码/记录:%s 次数=%s 已用=%s X残留=%s', ok, n, n2, n3)); end if;

  -- 33b. 超过 15 分钟的保留不算数：同邮箱同码要照正常规则再扣
  total := total + 1;
  c5 := svc.svc_new_invite_code(2);
  ok := svc.svc_redeem_invite(c5, 's1@test.invalid');
  perform set_config('role', 'postgres', true);
  update private.invite_uses set used_at = now() - interval '16 minutes' where code = c5;
  update private.invite_codes set active = false where code = c5;
  perform set_config('role', 'service_role', true);
  ok2 := svc.svc_redeem_invite(c5, 's1@test.invalid');
  if ok and not ok2 then pass := pass + 1;
  else fails := array_append(fails, format('过时保留:%s/%s', ok, ok2)); end if;

  -- 34. 没有保留也能记录（补写一笔）
  total := total + 1;
  perform svc.svc_record_invite_use(c1, 'z1@test.invalid', b);
  perform set_config('role', 'postgres', true);
  select count(*) into n from private.invite_uses where code = c1 and email = 'z1@test.invalid' and status = 'used';
  perform set_config('role', 'service_role', true);
  if n = 1 then pass := pass + 1; else fails := array_append(fails, '没保留时没补写'::text); end if;

  -- 35. 过期码、停用码、不存在的码 → 失败
  total := total + 1;
  c2 := svc.svc_new_invite_code();
  c3 := svc.svc_new_invite_code();
  perform set_config('role', 'postgres', true);
  update private.invite_codes set expires_at = now() - interval '1 second' where code = c2;
  update private.invite_codes set active = false where code = c3;
  perform set_config('role', 'service_role', true);
  if not svc.svc_redeem_invite(c2, 'e1@test.invalid') and not svc.svc_redeem_invite(c3, 'e1@test.invalid')
     and not svc.svc_redeem_invite('ZZZZZZZZ', 'e1@test.invalid') then pass := pass + 1;
  else fails := array_append(fails, '过期/停用/不存在的码竟然能用'::text); end if;

  -- 36. 账号被删后，同一邮箱再用同一码 → 要真的再扣一次（不能当成旧保留）
  total := total + 1;
  c4 := svc.svc_new_invite_code(2);
  ok := svc.svc_redeem_invite(c4, 'b@test.invalid');
  perform svc.svc_record_invite_use(c4, 'b@test.invalid', b);
  perform set_config('role', 'postgres', true);
  delete from auth.users where id = b;
  perform set_config('role', 'service_role', true);
  ok2 := svc.svc_redeem_invite(c4, 'b@test.invalid');
  perform set_config('role', 'postgres', true);
  select used_count into n from private.invite_codes where code = c4;
  select count(*) into n2 from private.invite_uses where code = c4 and user_id is null and status = 'used';
  perform set_config('role', 'service_role', true);
  if ok and ok2 and n = 2 and n2 = 1 then pass := pass + 1;
  else fails := array_append(fails, format('删号后旧码:%s/%s 次数=%s', ok, ok2, n)); end if;

  -- 37. 注册检查：同一 IP 第 21 次 → limited、第 20 次不会；IP 是 null → 不限流；exists、owner 判断正确
  perform set_config('role', 'postgres', true);
  insert into private.register_attempts (key, at) select 'ip:9.9.9.9', now() from generate_series(1, 20);
  insert into private.register_attempts (key, at) select 'ip:8.8.8.8', now() from generate_series(1, 19);
  perform set_config('role', 'service_role', true);
  total := total + 1;
  r := svc.svc_register_check('a@test.invalid', '8.8.8.8');
  ok3 := not (r->>'limited')::boolean;
  r := svc.svc_register_check('a@test.invalid', '9.9.9.9');
  r2 := svc.svc_register_check(' A@Test.Invalid ', null);
  r3 := svc.svc_register_check('owner@test.invalid', null);
  if ok3 and (r->>'limited')::boolean and not (r2->>'limited')::boolean and (r2->>'exists')::boolean
     and (r3->>'owner')::boolean and not (r3->>'exists')::boolean then pass := pass + 1;
  else fails := array_append(fails, ('注册检查:' || r::text || r2::text || r3::text)); end if;

  -- 38. 一般用户、未登录：叫不动 svc 函数、读不到 private 表
  total := total + 1;
  ok := true;
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin perform svc.svc_otp_reserve('p@test.invalid'); ok := false; exception when insufficient_privilege then null; end;
  begin perform svc.svc_new_invite_code(); ok := false; exception when insufficient_privilege then null; end;
  begin select count(*) into n from private.owner_emails; ok := false; exception when insufficient_privilege then null; end;
  begin select count(*) into n from private.invite_codes; ok := false; exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('role', 'anon', true);
  begin perform svc.svc_otp_reserve('p@test.invalid'); ok := false; exception when insufficient_privilege then null; end;
  begin perform svc.svc_redeem_invite('AAAAAAAA', 'p@test.invalid'); ok := false; exception when insufficient_privilege then null; end;
  begin select count(*) into n from private.otp_sends; ok := false; exception when insufficient_privilege then null; end;
  if ok then pass := pass + 1; else fails := array_append(fails, '一般用户或未登录碰得到内部资料'::text); end if;

  -- 39. 第二层防线：就算 schema 权限漏了，函数和表本身也没开放给 anon、authenticated
  perform set_config('role', 'postgres', true);
  total := total + 1;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace,
         unnest(array['anon', 'authenticated']) rl
   where s.nspname = 'svc' and has_function_privilege(rl, p.oid, 'execute');
  select count(*) into n2 from pg_class c join pg_namespace s on s.oid = c.relnamespace,
         unnest(array['anon', 'authenticated']) rl
   where s.nspname = 'private' and c.relkind = 'r'
     and has_table_privilege(rl, c.oid, 'select, insert, update, delete');
  select count(*) into n3 from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'private' and c.relkind = 'r' and not c.relrowsecurity;
  if n = 0 and n2 = 0 and n3 = 0 then pass := pass + 1;
  else fails := array_append(fails, format('第二层防线:函数%s 表%s 没开RLS%s', n, n2, n3)); end if;

  raise exception 'VERIFY 2b: % / % PASS。失败: %', pass, total,
    case when cardinality(fails) = 0 then '无' else array_to_string(fails, '；') end;
end
$$;
