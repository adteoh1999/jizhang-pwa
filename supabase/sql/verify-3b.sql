-- 记账 App · 3b 的检查（svc_tg_touch、连接通知信 svc_tg_notify_reserve／release、tg_notify_sends）
-- 用法：supabase db query --remote -f supabase/sql/verify-3b.sql --yes（或贴到 SQL Editor 按 Run）。
-- 结果：一定会出现一个「错误」，内容是 VERIFY 3b: 通过数 / 总数 PASS。
--       这是故意的：用错误结束，脚本里建的临时用户、连接、通知纪录会全部自动撤回，不留垃圾。
-- 每一项都包在自己的 begin … exception 里：某一项出错只记成失败，其他项照样检查。
-- 测试用 Telegram id 用 5000000311 起的假号段（> 2^31）；以后正式资料撞号会假失败。

do $$
declare
  ua uuid := '00000000-0000-4000-8000-0000000003b1';  -- 主角
  ub uuid := '00000000-0000-4000-8000-0000000003b2';  -- 别人
  uc uuid := '00000000-0000-4000-8000-0000000003b3';  -- 24 小时内已寄满 3 封
  ud uuid := '00000000-0000-4000-8000-0000000003b4';  -- 删号连带
  ue uuid := '00000000-0000-4000-8000-0000000003b5';  -- 解除后重新连接
  ta bigint := 5000000311;
  tb bigint := 5000000312;
  tc bigint := 5000000313;
  td bigint := 5000000314;
  te bigint := 5000000315;
  tz bigint := 5000000319;  -- 没有连接
  pass  int := 0;
  total int := 0;
  fails text[] := '{}';
  ok  boolean;
  n   int;
  n2  int;
  v   text;
  j   jsonb;
  j2  jsonb;
  f   text;
  u   uuid;
  ts  timestamptz;
begin
  insert into auth.users (instance_id, id, aud, role, email, raw_app_meta_data)
  values ('00000000-0000-0000-0000-000000000000', ua, 'authenticated', 'authenticated', 'ua3b@test.invalid', '{"kind":"email"}'),
         ('00000000-0000-0000-0000-000000000000', ub, 'authenticated', 'authenticated', 'ub3b@test.invalid', '{"kind":"email"}'),
         ('00000000-0000-0000-0000-000000000000', uc, 'authenticated', 'authenticated', 'uc3b@test.invalid', '{"kind":"email"}'),
         ('00000000-0000-0000-0000-000000000000', ud, 'authenticated', 'authenticated', 'ud3b@test.invalid', '{"kind":"email"}');
  insert into private.telegram_links (telegram_id, user_id, kind, tg_label)
  values (ta, ua, 'email', '旧名字'), (tb, ub, 'email', ''), (tc, uc, 'email', ''), (td, ud, 'email', '');

  -- 1. 3 个函数都在 svc、security definer、search_path = ''；notified_at 栏位在、预设 null；tg_notify_sends 开了 RLS
  total := total + 1;
  begin
    n := 0;
    v := '';
    foreach f in array array[
      'svc.svc_tg_touch(bigint,text)', 'svc.svc_tg_notify_reserve(bigint,uuid)', 'svc.svc_tg_notify_release(bigint,bigint)']
    loop
      if exists (select 1 from pg_proc p where p.oid = to_regprocedure(f)
                  and p.prosecdef and 'search_path=""' = any(coalesce(p.proconfig, '{}'))) then
        n := n + 1;
      else
        v := v || f || ' ';
      end if;
    end loop;
    ok := n = 3
      and (select notified_at is null from private.telegram_links where telegram_id = ta)
      and exists (select 1 from pg_class where oid = 'private.tg_notify_sends'::regclass and relrowsecurity);
    if ok then pass := pass + 1; else fails := array_append(fails, ('1 函数／栏位／RLS 不对:' || v)); end if;
  exception when others then fails := array_append(fails, ('1:' || sqlerrm));
  end;

  -- 2. touch：有连接 → 回 user_id、名字更新（去前后空白；超过 64 字截掉）；bigint 没被截断
  total := total + 1;
  begin
    u := svc.svc_tg_touch(ta, '  @alice  ');
    select tg_label into v from private.telegram_links where telegram_id = ta;
    ok := u = ua and v = '@alice';
    u := svc.svc_tg_touch(ta, repeat('名', 70));
    select tg_label into v from private.telegram_links where telegram_id = ta;
    ok := ok and u = ua and v = repeat('名', 64);
    if ok then pass := pass + 1; else fails := array_append(fails, ('2 touch 更新名字:' || coalesce(u::text, 'null') || '/' || coalesce(v, 'null'))); end if;
  exception when others then fails := array_append(fails, ('2:' || sqlerrm));
  end;

  -- 3. touch：名字是空白、空字串、null → 不覆盖原名字，仍回 user_id
  total := total + 1;
  begin
    update private.telegram_links set tg_label = '原名' where telegram_id = ta;
    ok := svc.svc_tg_touch(ta, '   ') = ua and svc.svc_tg_touch(ta, '') = ua and svc.svc_tg_touch(ta, null) = ua;
    select tg_label into v from private.telegram_links where telegram_id = ta;
    ok := ok and v = '原名';
    if ok then pass := pass + 1; else fails := array_append(fails, ('3 空白名字覆盖了原名字:' || coalesce(v, 'null'))); end if;
  exception when others then fails := array_append(fails, ('3:' || sqlerrm));
  end;

  -- 4. touch：没有连接 → null，而且没有新增任何连接（只 update、绝不 insert）
  total := total + 1;
  begin
    select count(*) into n from private.telegram_links;
    u := svc.svc_tg_touch(tz, '@nobody');
    select count(*) into n2 from private.telegram_links;
    ok := u is null and n = n2 and not exists (select 1 from private.telegram_links where telegram_id = tz);
    if ok then pass := pass + 1; else fails := array_append(fails, ('4 没连接时 touch 不对:' || coalesce(u::text, 'null') || ' ' || n || '→' || n2)); end if;
  exception when others then fails := array_append(fails, ('4:' || sqlerrm));
  end;

  -- 5. 参数不合格 → raise（touch、reserve、release）
  total := total + 1;
  begin
    ok := true;
    begin perform svc.svc_tg_touch(null, 'x');            ok := false; exception when raise_exception then null; end;
    begin perform svc.svc_tg_touch(0, 'x');               ok := false; exception when raise_exception then null; end;
    begin perform svc.svc_tg_touch(-1, 'x');              ok := false; exception when raise_exception then null; end;
    begin perform svc.svc_tg_notify_reserve(null, ua);    ok := false; exception when raise_exception then null; end;
    begin perform svc.svc_tg_notify_reserve(0, ua);       ok := false; exception when raise_exception then null; end;
    begin perform svc.svc_tg_notify_reserve(ta, null);    ok := false; exception when raise_exception then null; end;
    begin perform svc.svc_tg_notify_release(null, ta);    ok := false; exception when raise_exception then null; end;
    begin perform svc.svc_tg_notify_release(1, 0);        ok := false; exception when raise_exception then null; end;
    if ok then pass := pass + 1; else fails := array_append(fails, '5 参数不合格没有 raise'::text); end if;
  exception when others then fails := array_append(fails, ('5:' || sqlerrm));
  end;

  -- 6. reserve：第一次 send（有 id、记一笔、notified_at 有值）→ 第二次 skip（不多记）
  total := total + 1;
  begin
    j := svc.svc_tg_notify_reserve(ta, ua);
    j2 := svc.svc_tg_notify_reserve(ta, ua);
    select count(*) into n from private.tg_notify_sends where user_id = ua;
    ok := j->>'do' = 'send' and (j->>'id') is not null
      and exists (select 1 from private.tg_notify_sends where id = (j->>'id')::bigint and user_id = ua)
      and (select notified_at is not null from private.telegram_links where telegram_id = ta)
      and j2 = '{"do":"skip"}'::jsonb and n = 1;
    if ok then pass := pass + 1; else fails := array_append(fails, ('6 reserve 第一次／第二次:' || coalesce(j::text, 'null') || ' ' || coalesce(j2::text, 'null') || ' n=' || n)); end if;
  exception when others then fails := array_append(fails, ('6:' || sqlerrm));
  end;

  -- 7. release：删掉占位那笔、notified_at 改回 null → 再 reserve 又是 send
  total := total + 1;
  begin
    select id into n from private.tg_notify_sends where user_id = ua;
    perform svc.svc_tg_notify_release(n, ta);
    ok := not exists (select 1 from private.tg_notify_sends where user_id = ua)
      and (select notified_at is null from private.telegram_links where telegram_id = ta);
    j := svc.svc_tg_notify_reserve(ta, ua);
    ok := ok and j->>'do' = 'send';
    if ok then pass := pass + 1; else fails := array_append(fails, ('7 release 后再 reserve:' || coalesce(j::text, 'null'))); end if;
  exception when others then fails := array_append(fails, ('7:' || sqlerrm));
  end;

  -- 8. 24 小时内已寄 3 封 → limited、不多记、notified_at 有值；之后 skip。超过 24 小时的不算；2 天前的会被清掉
  total := total + 1;
  begin
    insert into private.tg_notify_sends (user_id, sent_at)
    values (uc, now() - interval '1 hour'), (uc, now() - interval '2 hours'), (uc, now() - interval '23 hours'),
           (uc, now() - interval '25 hours'), (uc, now() - interval '3 days');
    j := svc.svc_tg_notify_reserve(tc, uc);
    select count(*) into n from private.tg_notify_sends where user_id = uc;
    ok := j = '{"do":"limited"}'::jsonb and n = 4  -- 3 天前那笔被清掉，没有新增
      and (select notified_at is not null from private.telegram_links where telegram_id = tc)
      and svc.svc_tg_notify_reserve(tc, uc) = '{"do":"skip"}'::jsonb;
    -- 只剩 2 封在 24 小时内 → 可以寄
    delete from private.tg_notify_sends where user_id = uc and sent_at > now() - interval '90 minutes';
    update private.telegram_links set notified_at = null where telegram_id = tc;
    ok := ok and svc.svc_tg_notify_reserve(tc, uc)->>'do' = 'send';
    if ok then pass := pass + 1; else fails := array_append(fails, ('8 24 小时上限:' || coalesce(j::text, 'null') || ' n=' || n)); end if;
  exception when others then fails := array_append(fails, ('8:' || sqlerrm));
  end;

  -- 9. reserve：连接不在、或这个 Telegram 连的是别人 → skip，不记任何东西
  total := total + 1;
  begin
    select count(*) into n from private.tg_notify_sends;
    ok := svc.svc_tg_notify_reserve(tz, ua) = '{"do":"skip"}'::jsonb
      and svc.svc_tg_notify_reserve(tb, ua) = '{"do":"skip"}'::jsonb
      and (select notified_at is null from private.telegram_links where telegram_id = tb);
    select count(*) into n2 from private.tg_notify_sends;
    ok := ok and n = n2;
    if ok then pass := pass + 1; else fails := array_append(fails, ('9 不该寄的没有 skip:' || n || '→' || n2)); end if;
  exception when others then fails := array_append(fails, ('9:' || sqlerrm));
  end;

  -- 10. release 拿到别人那笔的 id → 不会把这个连接改回「还没寄」
  total := total + 1;
  begin
    j := svc.svc_tg_notify_reserve(tb, ub);   -- ub 的一笔
    select notified_at into ts from private.telegram_links where telegram_id = ta;  -- ua 目前已寄（第 7 项）
    perform svc.svc_tg_notify_release((j->>'id')::bigint, ta);
    ok := j->>'do' = 'send' and ts is not null
      and (select notified_at from private.telegram_links where telegram_id = ta) = ts;
    if ok then pass := pass + 1; else fails := array_append(fails, ('10 release 改到别人的连接:' || coalesce(j::text, 'null'))); end if;
  exception when others then fails := array_append(fails, ('10:' || sqlerrm));
  end;

  -- 11. 删号：svc_delete_user_data 清掉通知纪录；auth 账号删掉时也跟着删（cascade）
  total := total + 1;
  begin
    perform svc.svc_tg_notify_reserve(td, ud);
    insert into private.tg_notify_sends (user_id) values (ud);
    perform svc.svc_delete_user_data(ud);
    ok := not exists (select 1 from private.tg_notify_sends where user_id = ud);
    insert into private.tg_notify_sends (user_id) values (ud);
    delete from auth.users where id = ud;
    ok := ok and not exists (select 1 from private.tg_notify_sends where user_id = ud);
    if ok then pass := pass + 1; else fails := array_append(fails, '11 删号没清掉通知纪录'::text); end if;
  exception when others then fails := array_append(fails, ('11:' || sqlerrm));
  end;

  -- 12. 权限：anon、authenticated 不能执行；service_role 可以；实际叫一次 → insufficient_privilege；也读不到 tg_notify_sends
  total := total + 1;
  begin
    ok := true;
    foreach f in array array[
      'svc.svc_tg_touch(bigint,text)', 'svc.svc_tg_notify_reserve(bigint,uuid)', 'svc.svc_tg_notify_release(bigint,bigint)']
    loop
      ok := ok and not has_function_privilege('anon', f, 'execute')
               and not has_function_privilege('authenticated', f, 'execute')
               and has_function_privilege('service_role', f, 'execute');
    end loop;
    ok := ok and not has_table_privilege('anon', 'private.tg_notify_sends', 'select')
             and not has_table_privilege('authenticated', 'private.tg_notify_sends', 'select');
    grant usage on schema svc to anon, authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    begin perform svc.svc_tg_touch(ta, 'x');              ok := false; exception when insufficient_privilege then null; end;
    begin perform svc.svc_tg_notify_reserve(ta, ua);      ok := false; exception when insufficient_privilege then null; end;
    begin perform svc.svc_tg_notify_release(1, ta);       ok := false; exception when insufficient_privilege then null; end;
    perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
    perform set_config('role', 'anon', true);
    begin perform svc.svc_tg_touch(ta, 'x');              ok := false; exception when insufficient_privilege then null; end;
    begin perform svc.svc_tg_notify_reserve(ta, ua);      ok := false; exception when insufficient_privilege then null; end;
    perform set_config('role', 'postgres', true);
    revoke usage on schema svc from anon, authenticated;
    if ok then pass := pass + 1; else fails := array_append(fails, '12 一般用户或未登录叫得动 3b 函数'::text); end if;
  exception when others then
    perform set_config('role', 'postgres', true);
    fails := array_append(fails, ('12:' || sqlerrm));
  end;

  -- 13. release 只清「自己那次预约设的」notified_at：预约后连接被解除、又重新连接（新连接已有自己的 notified_at）
  --     → 旧请求的 release 只删掉自己那一笔，不能把新连接改回「还没寄」（审核 S6）
  total := total + 1;
  begin
    insert into auth.users (instance_id, id, aud, role, email, raw_app_meta_data)
    values ('00000000-0000-0000-0000-000000000000', ue, 'authenticated', 'authenticated', 'ue3b@test.invalid', '{"kind":"email"}');
    insert into private.telegram_links (telegram_id, user_id, kind, tg_label) values (te, ue, 'email', '');
    j := svc.svc_tg_notify_reserve(te, ue);
    delete from private.telegram_links where telegram_id = te;
    insert into private.telegram_links (telegram_id, user_id, kind, tg_label, notified_at)
    values (te, ue, 'email', '', clock_timestamp());
    select notified_at into ts from private.telegram_links where telegram_id = te;
    perform svc.svc_tg_notify_release((j->>'id')::bigint, te);
    ok := j->>'do' = 'send' and ts is not null
      and (select notified_at from private.telegram_links where telegram_id = te) = ts
      and not exists (select 1 from private.tg_notify_sends where id = (j->>'id')::bigint);
    if ok then pass := pass + 1; else fails := array_append(fails, ('13 旧的 release 清掉了新连接的 notified_at:' || coalesce(j::text, 'null'))); end if;
  exception when others then fails := array_append(fails, ('13:' || sqlerrm));
  end;

  -- 15. reserve 回 send 时带这次连接的 linked_at（给 Resend 幂等键用），而且 notified_at = 那一笔的 sent_at（release 靠它比对）
  total := total + 1;
  begin
    update private.telegram_links set notified_at = null where telegram_id = tb;
    j := svc.svc_tg_notify_reserve(tb, ub);
    ok := j->>'do' = 'send'
      and (j->>'linked_at')::timestamptz = (select linked_at from private.telegram_links where telegram_id = tb)
      and (select notified_at from private.telegram_links where telegram_id = tb)
          = (select sent_at from private.tg_notify_sends where id = (j->>'id')::bigint);
    if ok then pass := pass + 1; else fails := array_append(fails, ('15 reserve 没带 linked_at 或时间不一致:' || coalesce(j::text, 'null'))); end if;
  exception when others then fails := array_append(fails, ('15:' || sqlerrm));
  end;

  -- 14. touch、reserve、release 都设了 lock_timeout = 3s（tg-link 的 bind rpc 等 4 秒、要比锁等待长）
  total := total + 1;
  begin
    n := 0;
    foreach f in array array[
      'svc.svc_tg_touch(bigint,text)', 'svc.svc_tg_notify_reserve(bigint,uuid)', 'svc.svc_tg_notify_release(bigint,bigint)']
    loop
      if exists (select 1 from pg_proc p where p.oid = to_regprocedure(f) and 'lock_timeout=3s' = any(coalesce(p.proconfig, '{}'))) then
        n := n + 1;
      end if;
    end loop;
    ok := n = 3;
    if ok then pass := pass + 1; else fails := array_append(fails, ('14 lock_timeout 没设好:' || n)); end if;
  exception when others then fails := array_append(fails, ('14:' || sqlerrm));
  end;

  raise exception 'VERIFY 3b: % / % PASS。失败: %', pass, total,
    case when cardinality(fails) = 0 then '无' else array_to_string(fails, '；') end;
end
$$;
