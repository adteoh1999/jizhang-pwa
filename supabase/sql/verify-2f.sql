-- 记账 App · 2f 验收脚本（邀请码管理、删除用户资料的 svc 函数）
-- 用法：supabase db query --remote -f supabase/sql/verify-2f.sql --yes（或贴到 SQL Editor 按 Run）。
-- 结果：一定会出现一个「错误」，内容是 VERIFY 2f: 通过数 / 总数 PASS。
--       这是故意的：用错误结束，脚本里建的临时用户、邀请码与测试资料会全部自动撤回，不留垃圾。
-- 每一项都包在自己的 begin … exception 里：某一项出错只记成失败，其他项照样检查。

do $$
declare
  u1 uuid := '00000000-0000-4000-8000-0000000002f1';  -- 一般用户（有资料，会被删）
  u2 uuid := '00000000-0000-4000-8000-0000000002f2';  -- 活着，但使用纪录 user_id 是 null
  u4 uuid := '00000000-0000-4000-8000-0000000002f4';  -- 站主（快照邮箱就是站主）
  u5 uuid := '00000000-0000-4000-8000-0000000002f5';  -- 先删资料、再删账号
  u6 uuid := '00000000-0000-4000-8000-0000000002f6';  -- 现在的邮箱是站主，快照邮箱不是（S5）
  u7 uuid := '00000000-0000-4000-8000-0000000002f7';  -- 删号半失败：email 已清、账号还在（S6）
  u8 uuid := '00000000-0000-4000-8000-0000000002f8';  -- 账号已建好，但纪录停在 reserved（record 失败）
  u9 uuid := '00000000-0000-4000-8000-0000000002f9';  -- 同一个码上各有一笔 reserved 的两个人（M-1）
  ua uuid := '00000000-0000-4000-8000-0000000002fa';
  ux uuid := '00000000-0000-4000-8000-0000000002ff';  -- 别人（资料不能被误删）
  t1 uuid := '00000000-0000-4000-8000-0000000002a1';
  t2 uuid := '00000000-0000-4000-8000-0000000002a2';
  pass  int := 0;
  total int := 0;
  fails text[] := '{}';
  ok  boolean;
  ok2 boolean;
  n   int;
  n2  int;
  n3  int;
  n4  int;
  v   text;
  r   jsonb;
  e1  jsonb;
  c1  text;
  c2  text;
  c3  text;
  c4  text;
  c5  text;
  c6  text;
  cu  text;
  f   text;
  cm  text;
begin
  -- 临时测试用户（脚本结束时会被撤回）
  insert into auth.users (instance_id, id, aud, role, email)
  values ('00000000-0000-0000-0000-000000000000', u1, 'authenticated', 'authenticated', 'u1@test.invalid'),
         ('00000000-0000-0000-0000-000000000000', u2, 'authenticated', 'authenticated', 'u2@test.invalid'),
         ('00000000-0000-0000-0000-000000000000', u4, 'authenticated', 'authenticated', 'owner2f@test.invalid'),
         ('00000000-0000-0000-0000-000000000000', u5, 'authenticated', 'authenticated', 'u5@test.invalid'),
         ('00000000-0000-0000-0000-000000000000', u6, 'authenticated', 'authenticated', 'owner2f-b@test.invalid'),
         ('00000000-0000-0000-0000-000000000000', u7, 'authenticated', 'authenticated', 'u7@test.invalid'),
         ('00000000-0000-0000-0000-000000000000', u8, 'authenticated', 'authenticated', 'u8@test.invalid'),
         ('00000000-0000-0000-0000-000000000000', u9, 'authenticated', 'authenticated', 'u9@test.invalid'),
         ('00000000-0000-0000-0000-000000000000', ua, 'authenticated', 'authenticated', 'ua@test.invalid'),
         ('00000000-0000-0000-0000-000000000000', ux, 'authenticated', 'authenticated', 'ux@test.invalid');
  insert into private.owner_emails (email) values ('owner2f@test.invalid'), ('owner2f-b@test.invalid');

  -- 1. 6 个函数都在 svc、都是 security definer、search_path = ''
  total := total + 1;
  begin
    n := 0;
    v := '';
    foreach f in array array[
      'svc.svc_is_owner(text)', 'svc.svc_new_invite_code(integer,integer,text)', 'svc.svc_invites_list()',
      'svc.svc_invite_set_active(text,boolean)', 'svc.svc_invite_uses(text)', 'svc.svc_delete_user_data(uuid)']
    loop
      if exists (select 1 from pg_proc p where p.oid = to_regprocedure(f)
                  and p.prosecdef and 'search_path=""' = any(coalesce(p.proconfig, '{}'))) then
        n := n + 1;
      else
        v := v || f || ' ';
      end if;
    end loop;
    if n = 6 then pass := pass + 1; else fails := array_append(fails, ('函数缺或设定不对:' || v)); end if;
  exception when others then fails := array_append(fails, ('1:' || sqlerrm));
  end;

  -- 2. 权限：anon、authenticated 都不能执行；service_role 可以
  total := total + 1;
  begin
    select count(*) into n from unnest(array[
      'svc.svc_is_owner(text)', 'svc.svc_new_invite_code(integer,integer,text)', 'svc.svc_invites_list()',
      'svc.svc_invite_set_active(text,boolean)', 'svc.svc_invite_uses(text)', 'svc.svc_delete_user_data(uuid)']) fn,
      unnest(array['anon', 'authenticated']) rl
     where has_function_privilege(rl, fn, 'execute');
    select count(*) into n2 from unnest(array[
      'svc.svc_is_owner(text)', 'svc.svc_new_invite_code(integer,integer,text)', 'svc.svc_invites_list()',
      'svc.svc_invite_set_active(text,boolean)', 'svc.svc_invite_uses(text)', 'svc.svc_delete_user_data(uuid)']) fn
     where has_function_privilege('service_role', fn, 'execute');
    if n = 0 and n2 = 6 then pass := pass + 1;
    else fails := array_append(fails, format('权限:外人可执行%s service_role可执行%s/6', n, n2)); end if;
  exception when others then fails := array_append(fails, ('2:' || sqlerrm));
  end;

  perform set_config('role', 'service_role', true);

  -- 3. svc_is_owner：大小写与空白不影响；别人、null 都是 false
  total := total + 1;
  begin
    if svc.svc_is_owner(' Owner2F@Test.Invalid ') and not svc.svc_is_owner('u1@test.invalid')
       and not coalesce(svc.svc_is_owner(null), false) then pass := pass + 1;
    else fails := array_append(fails, '站主判断不对'::text); end if;
  exception when others then fails := array_append(fails, ('3:' || sqlerrm));
  end;

  -- 4. 新增邀请码的范围：次数 1–20、天数 1–365；超出就报错
  total := total + 1;
  begin
    n := 0;
    begin perform svc.svc_new_invite_code(21, 7);  exception when raise_exception then n := n + 1; end;
    begin perform svc.svc_new_invite_code(0, 7);   exception when raise_exception then n := n + 1; end;
    begin perform svc.svc_new_invite_code(1, 0);   exception when raise_exception then n := n + 1; end;
    begin perform svc.svc_new_invite_code(1, 366); exception when raise_exception then n := n + 1; end;
    begin perform svc.svc_new_invite_code(null, 7); exception when raise_exception then n := n + 1; end;
    c6 := svc.svc_new_invite_code(20, 365);
    if n = 5 and c6 ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$' then pass := pass + 1;
    else fails := array_append(fails, format('范围检查:报错%s/5 最大值%s', n, coalesce(c6, 'null'))); end if;
  exception when others then fails := array_append(fails, ('4:' || sqlerrm));
  end;

  -- 5. 天数 null → 永不过期；备注超过 40 字会被截断
  total := total + 1;
  begin
    c2 := svc.svc_new_invite_code(2, null, repeat('备', 45));
    perform set_config('role', 'postgres', true);
    select count(*) into n from private.invite_codes
     where code = c2 and expires_at is null and max_uses = 2 and note = repeat('备', 40);
    perform set_config('role', 'service_role', true);
    if n = 1 then pass := pass + 1; else fails := array_append(fails, '永不过期或备注截断不对'::text); end if;
  exception when others then fails := array_append(fails, ('5:' || sqlerrm));
  end;

  -- 6. 清单的状态：disabled → used_up → expired → active（依这个顺序判断）
  total := total + 1;
  begin
    c1 := svc.svc_new_invite_code(1, 7, '一般');
    c3 := svc.svc_new_invite_code(1, 1);   -- 改成过期
    c4 := svc.svc_new_invite_code(1, 7);   -- 改成用完＋过期 → used_up
    c5 := svc.svc_new_invite_code(1, 7);   -- 改成停用＋用完 → disabled
    perform set_config('role', 'postgres', true);
    update private.invite_codes set expires_at = now() - interval '1 second' where code in (c3, c4);
    update private.invite_codes set used_count = 1 where code in (c4, c5);
    update private.invite_codes set active = false where code = c5;
    update private.invite_codes set created_at = now() - interval '1 hour' where code = c1;
    update private.invite_codes set created_at = now() - interval '2 hours' where code = c2;
    perform set_config('role', 'service_role', true);
    r := svc.svc_invites_list();
    select string_agg(x->>'code' || '=' || (x->>'status'), ',') into v
      from jsonb_array_elements(r) x where x->>'code' in (c1, c2, c3, c4, c5);
    if jsonb_typeof(r) = 'array'
       and exists (select 1 from jsonb_array_elements(r) x where x->>'code' = c1 and x->>'status' = 'active')
       and exists (select 1 from jsonb_array_elements(r) x where x->>'code' = c2 and x->>'status' = 'active')
       and exists (select 1 from jsonb_array_elements(r) x where x->>'code' = c3 and x->>'status' = 'expired')
       and exists (select 1 from jsonb_array_elements(r) x where x->>'code' = c4 and x->>'status' = 'used_up')
       and exists (select 1 from jsonb_array_elements(r) x where x->>'code' = c5 and x->>'status' = 'disabled')
    then pass := pass + 1;
    else fails := array_append(fails, ('状态:' || coalesce(v, 'null'))); end if;
  exception when others then fails := array_append(fails, ('6:' || sqlerrm));
  end;

  -- 7. 清单栏位齐全、依 created_at 由新到旧
  total := total + 1;
  begin
    r := svc.svc_invites_list();
    select x into e1 from jsonb_array_elements(r) x where x->>'code' = c2;
    select min(o) filter (where x->>'code' = c1), min(o) filter (where x->>'code' = c2) into n, n2
      from jsonb_array_elements(r) with ordinality t(x, o);
    if e1 ?& array['code', 'max_uses', 'used_count', 'active', 'expires_at', 'note', 'created_at', 'status']
       and e1->'expires_at' = 'null'::jsonb and (e1->>'max_uses')::int = 2 and (e1->>'used_count')::int = 0
       and (e1->>'active')::boolean and n < n2 then pass := pass + 1;
    else fails := array_append(fails, format('清单栏位或次序:%s 位置%s/%s', e1, n, n2)); end if;
  exception when others then fails := array_append(fails, ('7:' || sqlerrm));
  end;

  -- 8. 停用／启用；找不到的码回 false
  total := total + 1;
  begin
    ok := svc.svc_invite_set_active(c1, false);
    select x->>'status' into v from jsonb_array_elements(svc.svc_invites_list()) x where x->>'code' = c1;
    ok2 := svc.svc_invite_set_active(c1, true);
    select x->>'status' into f from jsonb_array_elements(svc.svc_invites_list()) x where x->>'code' = c1;
    if ok and ok2 and v = 'disabled' and f = 'active' and not svc.svc_invite_set_active('00000000', true) then
      pass := pass + 1;
    else fails := array_append(fails, format('停用启用:%s/%s %s→%s', ok, ok2, v, f)); end if;
  exception when others then fails := array_append(fails, ('8:' || sqlerrm));
  end;

  -- 准备使用纪录（码 cu，次数够多）
  begin
    cu := svc.svc_new_invite_code(20, 7);
    perform set_config('role', 'postgres', true);
    insert into private.invite_uses (code, email, user_id, status, used_at) values
      (cu, 'u1@test.invalid',        u1,   'used',     now() - interval '10 hours'),
      (cu, 'u2@test.invalid',        null, 'used',     now() - interval '9 hours'),   -- M3：人还在、user_id 没记到
      (cu, 'gone@test.invalid',      null, 'used',     now() - interval '8 hours'),   -- 账号已不存在
      (cu, 'owner2f@test.invalid',   u4,   'used',     now() - interval '7 hours'),
      (cu, 'old-name@test.invalid',  u6,   'used',     now() - interval '6 hours'),   -- S5：后来改了邮箱成站主
      (cu, '',                       u7,   'used',     now() - interval '5 hours'),   -- S6：删号半失败
      (cu, 'pend@test.invalid',      null, 'reserved', now() - interval '20 minutes'),-- 超过 15 分钟的保留
      (cu, 'fresh@test.invalid',     null, 'reserved', now() - interval '1 minute'),  -- 刚保留、没账号：不列出
      (cu, 'u8@test.invalid',        null, 'reserved', now() - interval '2 minutes'); -- 保留、但账号已建好：当一般使用者
    perform set_config('role', 'service_role', true);
  exception when others then fails := array_append(fails, ('准备使用纪录:' || sqlerrm));
  end;

  -- 9. 使用明细：栏位齐全、由新到旧、刚保留且没账号的不列、超过 15 分钟且没账号的保留标 pending
  total := total + 1;
  begin
    r := svc.svc_invite_uses(cu);
    select string_agg(coalesce(nullif(x->>'email', ''), '(空)'), ',' order by o) into v
      from jsonb_array_elements(r) with ordinality t(x, o);
    select x into e1 from jsonb_array_elements(r) x where x->>'email' = 'pend@test.invalid';
    if jsonb_array_length(r) = 8
       and v = 'u8@test.invalid,pend@test.invalid,(空),old-name@test.invalid,owner2f@test.invalid,gone@test.invalid,u2@test.invalid,u1@test.invalid'
       and e1 ?& array['id', 'user_id', 'email', 'used_at', 'deleted', 'owner', 'pending']
       and (e1->>'pending')::boolean and not (e1->>'deleted')::boolean and not (e1->>'owner')::boolean
    then pass := pass + 1;
    else fails := array_append(fails, ('明细次序或栏位:' || coalesce(v, 'null') || ' ' || coalesce(e1::text, 'null'))); end if;
  exception when others then fails := array_append(fails, ('9:' || sqlerrm));
  end;

  -- 10. 使用明细：deleted、owner、user_id 判断（M3、S5、S6）
  total := total + 1;
  begin
    r := svc.svc_invite_uses(cu);
    v := '';
    -- u1：活着、一般用户
    select x into e1 from jsonb_array_elements(r) x where x->>'email' = 'u1@test.invalid';
    if not coalesce((e1->>'user_id')::uuid = u1 and not (e1->>'deleted')::boolean and not (e1->>'owner')::boolean
            and not (e1->>'pending')::boolean, false) then v := v || 'u1 '; end if;
    -- u2：user_id 没记到，但邮箱对得上活着的人 → 用对到的 id、不算已删除
    select x into e1 from jsonb_array_elements(r) x where x->>'email' = 'u2@test.invalid';
    if not coalesce((e1->>'user_id')::uuid = u2 and not (e1->>'deleted')::boolean, false) then v := v || 'u2 '; end if;
    -- gone：账号不存在 → 已删除、user_id null、不是站主
    select x into e1 from jsonb_array_elements(r) x where x->>'email' = 'gone@test.invalid';
    if not coalesce(e1->'user_id' = 'null'::jsonb and (e1->>'deleted')::boolean and not (e1->>'owner')::boolean, false) then v := v || 'gone '; end if;
    -- 站主
    select x into e1 from jsonb_array_elements(r) x where x->>'email' = 'owner2f@test.invalid';
    if not coalesce((e1->>'owner')::boolean and not (e1->>'deleted')::boolean, false) then v := v || 'owner '; end if;
    -- S5：快照邮箱不是站主，但现在的邮箱是 → 也算站主
    select x into e1 from jsonb_array_elements(r) x where x->>'email' = 'old-name@test.invalid';
    if not coalesce((e1->>'owner')::boolean, false) then v := v || 'S5 '; end if;
    -- S6：email 已清但账号还在 → 不算已删除（前端显示「删除未完成」、可再移除）
    select x into e1 from jsonb_array_elements(r) x where x->>'email' = '';
    if not coalesce((e1->>'user_id')::uuid = u7 and not (e1->>'deleted')::boolean, false) then v := v || 'S6 '; end if;
    -- 保留列但账号已建好（record 失败）→ 不是 pending、用对到的 id、可以移除
    select x into e1 from jsonb_array_elements(r) x where x->>'email' = 'u8@test.invalid';
    if not coalesce((e1->>'user_id')::uuid = u8 and not (e1->>'pending')::boolean and not (e1->>'deleted')::boolean, false) then v := v || 'u8 '; end if;
    if v = '' then pass := pass + 1; else fails := array_append(fails, ('明细判断错:' || v)); end if;
  exception when others then fails := array_append(fails, ('10:' || sqlerrm));
  end;

  -- 11. 找不到的码 → 空阵列
  total := total + 1;
  begin
    if svc.svc_invite_uses('00000000') = '[]'::jsonb then pass := pass + 1;
    else fails := array_append(fails, '找不到的码没回空阵列'::text); end if;
  exception when others then fails := array_append(fails, ('11:' || sqlerrm));
  end;

  -- 准备 u1 与别人的资料
  begin
    perform set_config('role', 'postgres', true);
    insert into public.transactions (user_id, id, kind, amount_minor, category_id, occurred_on, created_at, updated_at) values
      (u1, t1, 'expense', 100, 'food', '2026-11-25', now(), now()),
      (ux, t2, 'expense', 200, 'food', '2026-11-25', now(), now());
    insert into public.categories (user_id, id, kind, name, icon, sort, updated_at) values
      (u1, 'food', 'expense', '餐饮', 'food', 0, now()),
      (ux, 'food', 'expense', '餐饮', 'food', 0, now());
    insert into public.category_keywords (user_id, keyword, category_id, updated_at) values
      (u1, 'grab', 'transport', now()),
      (ux, 'grab', 'transport', now());
    insert into private.telegram_links (telegram_id, user_id, kind) values (900000001, u1, 'email'), (900000002, ux, 'email');
    -- M3：同一个人另一个码的保留（user_id null、邮箱相同）也要清
    insert into private.invite_uses (code, email, user_id, status, display_name, used_at) values
      (c1, 'u1@test.invalid', null, 'reserved', 'U1', now() - interval '30 minutes');
    update private.invite_uses set display_name = 'U1' where code = cu and user_id = u1;
    perform set_config('role', 'service_role', true);
  exception when others then fails := array_append(fails, ('准备资料:' || sqlerrm));
  end;

  -- 12. 删除用户资料：u1 的账、分类、关键词、Telegram 连结都没了；使用纪录的邮箱与名字清空
  total := total + 1;
  begin
    perform svc.svc_delete_user_data(u1);
    perform set_config('role', 'postgres', true);
    select (select count(*) from public.transactions where user_id = u1)
         + (select count(*) from public.categories where user_id = u1)
         + (select count(*) from public.category_keywords where user_id = u1)
         + (select count(*) from private.telegram_links where user_id = u1) into n;
    select count(*) into n2 from private.invite_uses where email = 'u1@test.invalid' or display_name = 'U1';
    select count(*) into n3 from private.invite_uses where code in (cu, c1) and email = '' and display_name = '';
    select count(*) into n4 from private.invite_uses where code = c1 and email = '' and status = 'used';
    perform set_config('role', 'service_role', true);
    if n = 0 and n2 = 0 and n3 = 3 and n4 = 1 then pass := pass + 1;   -- 3 = u1 两笔 + 原本的 S6 那笔；c1 那笔保留改成 used
    else fails := array_append(fails, format('删除资料:剩%s 邮箱残留%s 已清%s 保留改used%s', n, n2, n3, n4)); end if;
  exception when others then fails := array_append(fails, ('12:' || sqlerrm));
  end;

  -- 13. 别人的资料、别人的使用纪录都没被碰
  total := total + 1;
  begin
    perform set_config('role', 'postgres', true);
    select (select count(*) from public.transactions where user_id = ux)
         + (select count(*) from public.categories where user_id = ux)
         + (select count(*) from public.category_keywords where user_id = ux)
         + (select count(*) from private.telegram_links where user_id = ux) into n;
    select count(*) into n2 from private.invite_uses
     where code = cu and email in ('u2@test.invalid', 'gone@test.invalid', 'owner2f@test.invalid', 'pend@test.invalid');
    select count(*) into n3 from auth.users where id = u1;
    perform set_config('role', 'service_role', true);
    if n = 4 and n2 = 4 and n3 = 1 then pass := pass + 1;
    else fails := array_append(fails, format('误删:别人资料%s/4 别人纪录%s/4 账号本身%s', n, n2, n3)); end if;
  exception when others then fails := array_append(fails, ('13:' || sqlerrm));
  end;

  -- 14. 可以重复执行；不存在的用户也不出错
  total := total + 1;
  begin
    perform svc.svc_delete_user_data(u1);
    perform svc.svc_delete_user_data('00000000-0000-4000-8000-0000000002ee');
    perform set_config('role', 'postgres', true);
    select (select count(*) from public.transactions where user_id = ux)
         + (select count(*) from public.categories where user_id = ux)
         + (select count(*) from public.category_keywords where user_id = ux)
         + (select count(*) from private.telegram_links where user_id = ux) into n;
    select count(*) into n2 from private.invite_uses
     where code = cu and email in ('u2@test.invalid', 'gone@test.invalid', 'owner2f@test.invalid', 'pend@test.invalid', 'u8@test.invalid');
    perform set_config('role', 'service_role', true);
    if n = 4 and n2 = 5 then pass := pass + 1;
    else fails := array_append(fails, format('重复执行后误删:别人资料%s/4 别人纪录%s/5', n, n2)); end if;
  exception when others then fails := array_append(fails, ('14重复执行:' || sqlerrm));
  end;

  -- 15. 先删资料、再删账号 → 使用纪录 user_id null、email ''，明细显示 deleted、不是站主
  total := total + 1;
  begin
    perform set_config('role', 'postgres', true);
    insert into private.invite_uses (code, email, user_id, status, used_at) values (cu, 'u5@test.invalid', u5, 'used', now() - interval '1 hour');
    perform set_config('role', 'service_role', true);
    perform svc.svc_delete_user_data(u5);
    perform set_config('role', 'postgres', true);
    delete from auth.users where id = u5;
    select count(*) into n from private.invite_uses where code = cu and email = '' and user_id is null
       and used_at = (select max(used_at) from private.invite_uses where code = cu and status = 'used');
    perform set_config('role', 'service_role', true);
    r := svc.svc_invite_uses(cu);
    select count(*) into n2 from jsonb_array_elements(r) x where x->>'email' = '' and (x->>'deleted')::boolean;
    select x into e1 from jsonb_array_elements(r) x where x->>'email' = '' and (x->>'deleted')::boolean;
    if n = 1 and n2 = 1 and e1->'user_id' = 'null'::jsonb and not (e1->>'owner')::boolean
       and not (e1->>'pending')::boolean then pass := pass + 1;
    else fails := array_append(fails, format('删号后明细:%s %s %s', n, n2, e1)); end if;
  exception when others then fails := array_append(fails, ('15:' || sqlerrm));
  end;

  -- 15b. 同一个码上两个人各有一笔保留（user_id 没记到）→ 先后删除都不报错，两笔都变 used、email 清空
  total := total + 1;
  begin
    cm := svc.svc_new_invite_code(5, 7);
    perform set_config('role', 'postgres', true);
    insert into private.invite_uses (code, email, user_id, status, used_at) values
      (cm, 'u9@test.invalid', null, 'reserved', now() - interval '3 hours'),
      (cm, 'ua@test.invalid', null, 'reserved', now() - interval '2 hours');
    perform set_config('role', 'service_role', true);
    perform svc.svc_delete_user_data(u9);
    perform svc.svc_delete_user_data(ua);
    perform set_config('role', 'postgres', true);
    select count(*) into n from private.invite_uses where code = cm and email = '' and status = 'used';
    perform set_config('role', 'service_role', true);
    if n = 2 then pass := pass + 1; else fails := array_append(fails, format('两笔保留清除:%s/2', n)); end if;
  exception when others then
    perform set_config('role', 'service_role', true);
    fails := array_append(fails, ('15b:' || sqlerrm));
  end;

  -- 16. 一般用户、未登录叫不动新函数（函数这一层）
  --     svc schema 本来就不开放，那样任何呼叫都会被挡、测不到函数本身；这里临时开 schema 门（脚本最后会撤回）
  total := total + 1;
  begin
    perform set_config('role', 'postgres', true);
    ok := to_regprocedure('svc.svc_invites_list()') is not null and to_regprocedure('svc.svc_delete_user_data(uuid)') is not null
      and to_regprocedure('svc.svc_is_owner(text)') is not null and to_regprocedure('svc.svc_invite_uses(text)') is not null;
    grant usage on schema svc to anon, authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', ux, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    begin perform svc.svc_invites_list(); ok := false; exception when insufficient_privilege then null; end;
    begin perform svc.svc_delete_user_data(ux); ok := false; exception when insufficient_privilege then null; end;
    perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
    perform set_config('role', 'anon', true);
    begin perform svc.svc_is_owner('x@test.invalid'); ok := false; exception when insufficient_privilege then null; end;
    begin perform svc.svc_invite_uses('00000000'); ok := false; exception when insufficient_privilege then null; end;
    perform set_config('role', 'postgres', true);
    revoke usage on schema svc from anon, authenticated;
    if ok then pass := pass + 1; else fails := array_append(fails, '一般用户或未登录叫得动新函数'::text); end if;
  exception when others then
    perform set_config('role', 'postgres', true);
    fails := array_append(fails, ('16:' || sqlerrm));
  end;

  raise exception 'VERIFY 2f: % / % PASS。失败: %', pass, total,
    case when cardinality(fails) = 0 then '无' else array_to_string(fails, '；') end;
end
$$;
