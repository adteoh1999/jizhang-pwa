-- 记账 App · 3a 验收脚本（Telegram 连接函数 svc_tg_*、telegram_links.tg_label）
-- 用法：supabase db query --remote -f supabase/sql/verify-3a.sql --yes（或贴到 SQL Editor 按 Run）。
-- 结果：一定会出现一个「错误」，内容是 VERIFY 3a: 通过数 / 总数 PASS。
--       这是故意的：用错误结束，脚本里建的临时用户与连接会全部自动撤回，不留垃圾。
-- 每一项都包在自己的 begin … exception 里：某一项出错只记成失败，其他项照样检查。
-- 测试用 Telegram id 用 5000000301 起的假号段（> 2^31，顺便确认 bigint 没被截断）；以后正式资料撞号会假失败。

do $$
declare
  ue uuid := '00000000-0000-4000-8000-0000000003a1';  -- 邮箱账号（主角）
  uk uuid := '00000000-0000-4000-8000-0000000003a2';  -- kind 是空的（例如后台手建）
  uh uuid := '00000000-0000-4000-8000-0000000003a3';  -- kind=email，但 email 是空的（异常资料；现实中删号流程不会清 auth.users.email）
  ux uuid := '00000000-0000-4000-8000-0000000003a4';  -- 别人
  ud uuid := '00000000-0000-4000-8000-0000000003a5';  -- 会被删掉的账号
  uz uuid := '00000000-0000-4000-8000-0000000003af';  -- 不存在
  t1 bigint := 5000000301;
  t2 bigint := 5000000302;
  t3 bigint := 5000000303;
  t4 bigint := 5000000304;
  t5 bigint := 5000000305;
  pass  int := 0;
  total int := 0;
  fails text[] := '{}';
  ok  boolean;
  n   int;
  v   text;
  r   text;
  r2  text;
  j   jsonb;
  f   text;
  u   uuid;
begin
  -- 临时测试用户（脚本结束时会被撤回）
  insert into auth.users (instance_id, id, aud, role, email, raw_app_meta_data)
  values ('00000000-0000-0000-0000-000000000000', ue, 'authenticated', 'authenticated', 'ue3a@test.invalid', '{"kind":"email"}'),
         ('00000000-0000-0000-0000-000000000000', uk, 'authenticated', 'authenticated', 'uk3a@test.invalid', '{}'),
         ('00000000-0000-0000-0000-000000000000', uh, 'authenticated', 'authenticated', '',                  '{"kind":"email"}'),
         ('00000000-0000-0000-0000-000000000000', ux, 'authenticated', 'authenticated', 'ux3a@test.invalid', '{"kind":"email"}'),
         ('00000000-0000-0000-0000-000000000000', ud, 'authenticated', 'authenticated', 'ud3a@test.invalid', '{"kind":"email"}');

  -- 1. 4 个函数都在 svc、都是 security definer、search_path = ''
  total := total + 1;
  begin
    n := 0;
    v := '';
    foreach f in array array[
      'svc.svc_tg_link_get(bigint)', 'svc.svc_tg_bind(bigint,uuid,text)',
      'svc.svc_tg_unlink(uuid)', 'svc.svc_tg_status(uuid)']
    loop
      if exists (select 1 from pg_proc p where p.oid = to_regprocedure(f)
                  and p.prosecdef and 'search_path=""' = any(coalesce(p.proconfig, '{}'))) then
        n := n + 1;
      else
        v := v || f || ' ';
      end if;
    end loop;
    if n = 4 then pass := pass + 1; else fails := array_append(fails, ('1 函数缺或设定不对:' || v)); end if;
  exception when others then fails := array_append(fails, ('1:' || sqlerrm));
  end;

  -- 2. tg_label 栏：预设 ''、约束 telegram_links_tg_label_len 存在、65 字被挡
  total := total + 1;
  begin
    ok := exists (select 1 from pg_constraint where conname = 'telegram_links_tg_label_len'
                   and conrelid = 'private.telegram_links'::regclass);
    insert into private.telegram_links (telegram_id, user_id, kind) values (t5, ux, 'email');
    select tg_label into v from private.telegram_links where telegram_id = t5;
    ok := ok and v = '';
    delete from private.telegram_links where telegram_id = t5;
    begin
      insert into private.telegram_links (telegram_id, user_id, kind, tg_label) values (t5, ux, 'email', repeat('名', 65));
      ok := false;
    exception when check_violation then null;
    end;
    if ok then pass := pass + 1; else fails := array_append(fails, '2 tg_label 栏位或约束不对'::text); end if;
  exception when others then fails := array_append(fails, ('2:' || sqlerrm));
  end;

  -- 3. 没连接 → null；新连接 → 'linked'；link_get 拿得到；kind=email；id 没被截断；label 去空白
  total := total + 1;
  begin
    u := svc.svc_tg_link_get(t1);
    ok := u is null;
    r := svc.svc_tg_bind(t1, ue, '  Alice  ');
    ok := ok and r = 'linked' and svc.svc_tg_link_get(t1) = ue;
    ok := ok and exists (select 1 from private.telegram_links
                          where telegram_id = 5000000301 and user_id = ue and kind = 'email' and tg_label = 'Alice');
    if ok then pass := pass + 1; else fails := array_append(fails, ('3 新连接:' || coalesce(r, 'null'))); end if;
  exception when others then fails := array_append(fails, ('3:' || sqlerrm));
  end;

  -- 4. 同一组再连 → 'already'；新 label 会覆盖；空白 label 不覆盖
  total := total + 1;
  begin
    r := svc.svc_tg_bind(t1, ue, 'Alice2');
    select tg_label into v from private.telegram_links where telegram_id = t1;
    ok := r = 'already' and v = 'Alice2';
    r2 := svc.svc_tg_bind(t1, ue, '   ');
    select tg_label into v from private.telegram_links where telegram_id = t1;
    ok := ok and r2 = 'already' and v = 'Alice2';
    r2 := svc.svc_tg_bind(t1, ue, null);
    select tg_label into v from private.telegram_links where telegram_id = t1;
    ok := ok and r2 = 'already' and v = 'Alice2';
    if ok then pass := pass + 1; else fails := array_append(fails, ('4 重复连接:' || coalesce(r, 'null') || '/' || coalesce(v, 'null'))); end if;
  exception when others then fails := array_append(fails, ('4:' || sqlerrm));
  end;

  -- 5. Telegram 已连别人 → 'telegram_taken'；账号已连别的 Telegram → 'user_taken'；资料都不变
  total := total + 1;
  begin
    r := svc.svc_tg_bind(t1, ux, 'x');
    r2 := svc.svc_tg_bind(t2, ue, 'x');
    ok := r = 'telegram_taken' and r2 = 'user_taken'
      and svc.svc_tg_link_get(t1) = ue and svc.svc_tg_link_get(t2) is null
      and (select count(*) from private.telegram_links where user_id = ux) = 0;
    if ok then pass := pass + 1; else fails := array_append(fails, ('5 冲突:' || coalesce(r, 'null') || '/' || coalesce(r2, 'null'))); end if;
  exception when others then fails := array_append(fails, ('5:' || sqlerrm));
  end;

  -- 6. 顺序：Telegram 已连别人，而且这个账号也连了别的 Telegram → 'telegram_taken'（先查 Telegram）
  total := total + 1;
  begin
    r2 := svc.svc_tg_bind(t3, ux, 'X');
    r := svc.svc_tg_bind(t1, ux, 'x');
    ok := r2 = 'linked' and r = 'telegram_taken';
    if ok then pass := pass + 1; else fails := array_append(fails, ('6 判断顺序:' || coalesce(r2, 'null') || '/' || coalesce(r, 'null'))); end if;
  exception when others then fails := array_append(fails, ('6:' || sqlerrm));
  end;

  -- 7. 账号不存在 → 'no_user'；kind 不是 email → 'not_email'；email 是空的 → 'not_email'；账号检查在最前面
  total := total + 1;
  begin
    ok := svc.svc_tg_bind(t2, uz, 'x') = 'no_user';
    ok := ok and svc.svc_tg_bind(t2, uk, 'x') = 'not_email';
    ok := ok and svc.svc_tg_bind(t2, uh, 'x') = 'not_email';
    ok := ok and svc.svc_tg_bind(t1, uz, 'x') = 'no_user';
    ok := ok and svc.svc_tg_bind(t1, uk, 'x') = 'not_email';
    ok := ok and svc.svc_tg_link_get(t2) is null;
    if ok then pass := pass + 1; else fails := array_append(fails, '7 账号检查不对'::text); end if;
  exception when others then fails := array_append(fails, ('7:' || sqlerrm));
  end;

  -- 8. 参数不合格 → 一律 raise exception（程式错误，不是使用者情况）。只接 raise_exception（P0001）：
  --    其他错误（锁超时、权限、别的 bug）不算「有挡」，会落到外层记成失败
  total := total + 1;
  begin
    n := 0;
    begin perform svc.svc_tg_bind(0, ue, 'x');          exception when raise_exception then n := n + 1; end;
    begin perform svc.svc_tg_bind(-1, ue, 'x');         exception when raise_exception then n := n + 1; end;
    begin perform svc.svc_tg_bind(null, ue, 'x');       exception when raise_exception then n := n + 1; end;
    begin perform svc.svc_tg_bind(t2, null, 'x');       exception when raise_exception then n := n + 1; end;
    begin perform svc.svc_tg_link_get(0);               exception when raise_exception then n := n + 1; end;
    begin perform svc.svc_tg_link_get(-5);              exception when raise_exception then n := n + 1; end;
    begin perform svc.svc_tg_link_get(null);            exception when raise_exception then n := n + 1; end;
    begin perform svc.svc_tg_unlink(null);              exception when raise_exception then n := n + 1; end;
    begin perform svc.svc_tg_status(null);              exception when raise_exception then n := n + 1; end;
    -- 前提：函数存在（不然上面全部因为「函数不存在」而算成 exception）
    ok := n = 9 and to_regprocedure('svc.svc_tg_bind(bigint,uuid,text)') is not null
      and to_regprocedure('svc.svc_tg_link_get(bigint)') is not null
      and to_regprocedure('svc.svc_tg_unlink(uuid)') is not null
      and to_regprocedure('svc.svc_tg_status(uuid)') is not null;
    if ok then pass := pass + 1; else fails := array_append(fails, ('8 参数检查 exception 数:' || n)); end if;
  exception when others then fails := array_append(fails, ('8:' || sqlerrm));
  end;

  -- 9. status：已连接有 label、linked_at，没有 telegram_id；没连接 → {"linked": false}
  total := total + 1;
  begin
    j := svc.svc_tg_status(ue);
    ok := (j->>'linked')::boolean and j->>'label' = 'Alice2' and (j->>'linked_at') is not null
      and not (j ? 'telegram_id')
      and svc.svc_tg_status(uk) = '{"linked": false}'::jsonb;
    if ok then pass := pass + 1; else fails := array_append(fails, ('9 status:' || coalesce(j::text, 'null'))); end if;
  exception when others then fails := array_append(fails, ('9:' || sqlerrm));
  end;

  -- 10. 解除连接 → true；再解除 → false；之后查不到；同一人可以连另一个 Telegram
  total := total + 1;
  begin
    -- 一步一句：stable 函数（link_get）沿用「所在语句开始时」的快照，和改资料的函数写在同一句会看到旧资料
    ok := svc.svc_tg_unlink(ue) = true;
    ok := ok and svc.svc_tg_unlink(ue) = false;
    ok := ok and svc.svc_tg_link_get(t1) is null;
    ok := ok and svc.svc_tg_bind(t2, ue, 'Alice3') = 'linked';
    ok := ok and svc.svc_tg_link_get(t2) = ue;
    if ok then pass := pass + 1; else fails := array_append(fails, '10 解除连接不对'::text); end if;
  exception when others then fails := array_append(fails, ('10:' || sqlerrm));
  end;

  -- 11. 删 auth 账号 → 连接跟着消失；svc_delete_user_data → 连接消失；label 截 64 字
  total := total + 1;
  begin
    r := svc.svc_tg_bind(t4, ud, repeat('名', 70));
    select char_length(tg_label) into n from private.telegram_links where telegram_id = t4;
    ok := r = 'linked' and n = 64;
    delete from auth.users where id = ud;
    ok := ok and svc.svc_tg_link_get(t4) is null;
    perform svc.svc_delete_user_data(ue);
    ok := ok and svc.svc_tg_link_get(t2) is null
      and (select count(*) from private.telegram_links where user_id = ue) = 0;
    if ok then pass := pass + 1; else fails := array_append(fails, ('11 删号连带:' || coalesce(r, 'null') || '/' || coalesce(n::text, 'null'))); end if;
  exception when others then fails := array_append(fails, ('11:' || sqlerrm));
  end;

  -- 12. 权限：anon、authenticated 不能执行；service_role 可以；实际叫一次 → insufficient_privilege
  total := total + 1;
  begin
    ok := true;
    foreach f in array array[
      'svc.svc_tg_link_get(bigint)', 'svc.svc_tg_bind(bigint,uuid,text)',
      'svc.svc_tg_unlink(uuid)', 'svc.svc_tg_status(uuid)']
    loop
      ok := ok and not has_function_privilege('anon', f, 'execute')
               and not has_function_privilege('authenticated', f, 'execute')
               and has_function_privilege('service_role', f, 'execute');
    end loop;
    -- 就算 schema 权限漏了，函数本身也要挡住
    grant usage on schema svc to anon, authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', ux, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    begin perform svc.svc_tg_bind(t5, ux, 'x'); ok := false; exception when insufficient_privilege then null; end;
    begin perform svc.svc_tg_link_get(t3);      ok := false; exception when insufficient_privilege then null; end;
    begin perform svc.svc_tg_status(ux);        ok := false; exception when insufficient_privilege then null; end;
    perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
    perform set_config('role', 'anon', true);
    begin perform svc.svc_tg_unlink(ux);        ok := false; exception when insufficient_privilege then null; end;
    begin perform svc.svc_tg_link_get(t3);      ok := false; exception when insufficient_privilege then null; end;
    perform set_config('role', 'postgres', true);
    revoke usage on schema svc from anon, authenticated;
    if ok then pass := pass + 1; else fails := array_append(fails, '12 一般用户或未登录叫得动连接函数'::text); end if;
  exception when others then
    perform set_config('role', 'postgres', true);
    fails := array_append(fails, ('12:' || sqlerrm));
  end;

  raise exception 'VERIFY 3a: % / % PASS。失败: %', pass, total,
    case when cardinality(fails) = 0 then '无' else array_to_string(fails, '；') end;
end
$$;
