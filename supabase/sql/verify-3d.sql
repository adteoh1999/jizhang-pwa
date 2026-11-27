-- 记账 App · 3d 的检查（bot ＋ AI 记账：去重、AI 次数、同意、相似／大额、确认、撤销、改分类）
-- 用法：supabase db query --remote -f supabase/sql/verify-3d.sql --yes（或贴到 SQL Editor 按 Run）。
-- 结果：一定会出现一个「错误」，内容是 VERIFY 3d: 通过数 / 总数 PASS。
--       这是故意的：用错误结束，脚本里建的临时用户、连接、账目、纪录会全部自动撤回，不留垃圾。
-- 每一项都包在自己的 begin … exception 里：某一项出错只记成失败，其他项照样检查。
-- 测试用 Telegram id 用 5000000411 起的假号段；update_id 用 9000000001 起的假号段。
-- 注意：「两个连线同时 record」（相簿同时送，计划 M1）单一交易测不到，靠按人上锁的设计＋实测（计划 Task 10）。

do $$
declare
  ua uuid := '00000000-0000-4000-8000-0000000003d1';  -- 主角
  ub uuid := '00000000-0000-4000-8000-0000000003d2';  -- 别人
  uc uuid := '00000000-0000-4000-8000-0000000003d3';  -- 删号连带
  ud uuid := '00000000-0000-4000-8000-0000000003d4';  -- 换连接（最后一项）
  ta bigint := 5000000411;
  tb bigint := 5000000412;
  tc bigint := 5000000413;
  tz bigint := 5000000419;  -- 没有连接
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
  u2  uuid;
  d   date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  ts  timestamptz;
  fns text[] := array[
    'svc.svc_bot_claim(bigint,bigint)', 'svc.svc_bot_replied(bigint,bigint)', 'svc.svc_bot_finish(bigint,bigint)',
    'svc.svc_bot_ai_consent(bigint)', 'svc.svc_bot_ai_reserve(bigint,integer,integer)', 'svc.svc_bot_ai_refund(bigint,bigint)',
    'svc.svc_bot_ai_count()', 'svc.svc_bot_categories(bigint)',
    'svc.svc_bot_record(bigint,bigint,text,bigint,text,date,text,boolean)', 'svc.svc_bot_confirm(bigint,uuid)',
    'svc.svc_bot_discard(bigint,uuid)', 'svc.svc_bot_tx(bigint,uuid)', 'svc.svc_bot_undo(bigint,uuid)',
    'svc.svc_bot_set_category(bigint,uuid,text,text)'];
  locked text[] := array[
    'svc.svc_bot_claim(bigint,bigint)', 'svc.svc_bot_replied(bigint,bigint)', 'svc.svc_bot_finish(bigint,bigint)',
    'svc.svc_bot_ai_consent(bigint)', 'svc.svc_bot_ai_reserve(bigint,integer,integer)', 'svc.svc_bot_ai_refund(bigint,bigint)',
    'svc.svc_bot_record(bigint,bigint,text,bigint,text,date,text,boolean)', 'svc.svc_bot_confirm(bigint,uuid)',
    'svc.svc_bot_discard(bigint,uuid)', 'svc.svc_bot_undo(bigint,uuid)', 'svc.svc_bot_set_category(bigint,uuid,text,text)'];
  helpers text[] := array['private.bot_tx_json(uuid,uuid)', 'private.bot_outcome(uuid,text,uuid,uuid)', 'private.bot_lock_user(uuid)'];
begin
  insert into auth.users (instance_id, id, aud, role, email, raw_app_meta_data)
  values ('00000000-0000-0000-0000-000000000000', ua, 'authenticated', 'authenticated', 'ua3d@test.invalid', '{"kind":"email"}'),
         ('00000000-0000-0000-0000-000000000000', ub, 'authenticated', 'authenticated', 'ub3d@test.invalid', '{"kind":"email"}'),
         ('00000000-0000-0000-0000-000000000000', uc, 'authenticated', 'authenticated', 'uc3d@test.invalid', '{"kind":"email"}'),
         ('00000000-0000-0000-0000-000000000000', ud, 'authenticated', 'authenticated', 'ud3d@test.invalid', '{"kind":"email"}');
  insert into private.telegram_links (telegram_id, user_id, kind) values (ta, ua, 'email'), (tb, ub, 'email'), (tc, uc, 'email');

  -- 1. 14 个函数都在、definer、search_path = ''；写入类有 lock_timeout = 3s；anon／authenticated 不能执行、service_role 能；
  --    private 3 个小工具在、anon／authenticated 不能执行；
  --    3 张表开 RLS、anon／authenticated 不能读；telegram_links 有 ai_ok_at
  total := total + 1;
  begin
    v := '';
    foreach f in array fns loop
      if not exists (select 1 from pg_proc p where p.oid = to_regprocedure(f)
                      and p.prosecdef and 'search_path=""' = any(coalesce(p.proconfig, '{}'))) then
        v := v || f || ' ';
      elsif has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
        v := v || f || '(开放) ';
      elsif not has_function_privilege('service_role', f, 'execute') then
        v := v || f || '(service_role 不能用) ';
      end if;
    end loop;
    foreach f in array helpers loop
      if to_regprocedure(f) is null or has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
        v := v || f || '(小工具) ';
      end if;
    end loop;
    foreach f in array locked loop
      if not exists (select 1 from pg_proc p where p.oid = to_regprocedure(f) and 'lock_timeout=3s' = any(coalesce(p.proconfig, '{}'))) then
        v := v || f || '(锁) ';
      end if;
    end loop;
    foreach f in array array['private.bot_updates', 'private.bot_ai_uses', 'private.bot_pending'] loop
      if not exists (select 1 from pg_class where oid = f::regclass and relrowsecurity)
         or has_table_privilege('anon', f, 'select') or has_table_privilege('authenticated', f, 'select') then
        v := v || f || ' ';
      end if;
    end loop;
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'private' and table_name = 'telegram_links' and column_name = 'ai_ok_at') then
      v := v || 'ai_ok_at ';
    end if;
    ok := v = '';
    if ok then pass := pass + 1; else fails := array_append(fails, ('1 函数／权限／表不对:' || v)); end if;
  exception when others then fails := array_append(fails, ('1:' || sqlerrm));
  end;

  -- 2. claim：没连接 → unlinked、不写表；新 → go（ai_ok false）；立刻再 claim → busy；
  --    claimed_at 改成 3 分钟前 → go；同意后新 update 的 ai_ok = true
  total := total + 1;
  begin
    j := svc.svc_bot_claim(9000000001, tz);
    ok := j->>'do' = 'unlinked' and not exists (select 1 from private.bot_updates where update_id = 9000000001);
    j := svc.svc_bot_claim(9000000002, ta);
    ok := ok and j->>'do' = 'go' and (j->>'ai_ok')::boolean = false;
    j := svc.svc_bot_claim(9000000002, ta);
    ok := ok and j->>'do' = 'busy';
    update private.bot_updates set claimed_at = now() - interval '3 minutes' where update_id = 9000000002;
    j := svc.svc_bot_claim(9000000002, ta);
    ok := ok and j->>'do' = 'go';
    ok := ok and svc.svc_bot_ai_consent(ta) = true and svc.svc_bot_ai_consent(tz) = false;
    j := svc.svc_bot_claim(9000000003, ta);
    ok := ok and j->>'do' = 'go' and (j->>'ai_ok')::boolean = true;
    if ok then pass := pass + 1; else fails := array_append(fails, ('2 claim 状态不对:' || coalesce(j::text, 'null'))); end if;
  exception when others then fails := array_append(fails, ('2:' || sqlerrm));
  end;

  -- 3. record 成功：账 source='bot'、user_id 对、金额等对；同一 update 再 record → gone（只有一笔）；
  --    claim → resend（status recorded、带 tx）；replied 后 → dup；finish 的 → dup
  total := total + 1;
  begin
    j := svc.svc_bot_claim(9000000010, ta);
    j := svc.svc_bot_record(9000000010, ta, 'expense', 690, 'food', d, '早餐', false);
    u := (j->'tx'->>'id')::uuid;
    ok := j->>'status' = 'recorded'
      and exists (select 1 from public.transactions t where t.user_id = ua and t.id = u and t.source = 'bot'
                   and t.amount_minor = 690 and t.category_id = 'food' and t.note = '早餐' and not t.deleted);
    j2 := svc.svc_bot_record(9000000010, ta, 'expense', 690, 'food', d, '早餐', false);
    select count(*) into n from public.transactions where user_id = ua and amount_minor = 690;
    ok := ok and j2->>'status' = 'gone' and n = 1;
    j2 := svc.svc_bot_claim(9000000010, ta);
    ok := ok and j2->>'do' = 'resend' and j2->>'status' = 'recorded' and (j2->'tx'->>'id')::uuid = u;
    perform svc.svc_bot_replied(9000000010, ta);
    ok := ok and svc.svc_bot_claim(9000000010, ta)->>'do' = 'dup';
    perform svc.svc_bot_claim(9000000011, ta);
    perform svc.svc_bot_finish(9000000011, ta);
    ok := ok and svc.svc_bot_claim(9000000011, ta)->>'do' = 'dup';
    if ok then pass := pass + 1; else fails := array_append(fails, ('3 record／resend 不对:' || coalesce(j::text, 'null') || ' ' || coalesce(j2::text, 'null'))); end if;
  exception when others then fails := array_append(fails, ('3:' || sqlerrm));
  end;

  -- 4. 相似（只比同一天，D3）：同 kind、同金额、同一天 → asked/similar＋pending；差 1 天 → recorded；
  --    不同 kind → recorded；已删除的不算；claim → resend（status asked）
  total := total + 1;
  begin
    insert into public.transactions (user_id, id, kind, amount_minor, category_id, occurred_on, note, created_at, updated_at, source)
    values (ub, gen_random_uuid(), 'expense', 500, 'food', d, '咖啡', now(), now(), 'manual'),
           (ub, gen_random_uuid(), 'expense', 700, 'food', d, '已删', now(), now(), 'manual');
    update public.transactions set deleted = true, updated_at = now() + interval '1 millisecond'
     where user_id = ub and amount_minor = 700;
    perform svc.svc_bot_claim(9000000020, tb);
    j := svc.svc_bot_record(9000000020, tb, 'expense', 500, 'food', d, '咖啡', false);
    ok := j->>'status' = 'asked' and j->>'reason' = 'similar' and j->'similar'->>'note' = '咖啡'
      and exists (select 1 from private.bot_pending where id = (j->'pending'->>'id')::uuid and user_id = ub);
    j2 := svc.svc_bot_claim(9000000020, tb);
    ok := ok and j2->>'do' = 'resend' and j2->>'status' = 'asked' and j2->'pending'->>'id' = j->'pending'->>'id';
    perform svc.svc_bot_claim(9000000021, tb);
    ok := ok and svc.svc_bot_record(9000000021, tb, 'expense', 500, 'food', d - 1, '昨天', false)->>'status' = 'recorded';
    perform svc.svc_bot_claim(9000000022, tb);
    ok := ok and svc.svc_bot_record(9000000022, tb, 'income', 500, 'side', d, '收入', false)->>'status' = 'recorded';
    perform svc.svc_bot_claim(9000000023, tb);
    ok := ok and svc.svc_bot_record(9000000023, tb, 'expense', 700, 'food', d, '', false)->>'status' = 'recorded';
    if ok then pass := pass + 1; else fails := array_append(fails, ('4 相似检查不对:' || coalesce(j::text, 'null') || ' ' || coalesce(j2::text, 'null'))); end if;
  exception when others then fails := array_append(fails, ('4:' || sqlerrm));
  end;

  -- 5. 大额（D2）：p_ask_big → asked/big；同时相似又大额 → similar
  total := total + 1;
  begin
    perform svc.svc_bot_claim(9000000030, tb);
    j := svc.svc_bot_record(9000000030, tb, 'expense', 150000, 'shopping', d, '', true);
    ok := j->>'status' = 'asked' and j->>'reason' = 'big' and coalesce(j->'similar', 'null'::jsonb) = 'null'::jsonb;
    perform svc.svc_bot_claim(9000000031, tb);
    j2 := svc.svc_bot_record(9000000031, tb, 'expense', 500, 'food', d, '', true);
    ok := ok and j2->>'reason' = 'similar';
    if ok then pass := pass + 1; else fails := array_append(fails, ('5 大额不对:' || coalesce(j::text, 'null') || ' ' || coalesce(j2::text, 'null'))); end if;
  exception when others then fails := array_append(fails, ('5:' || sqlerrm));
  end;

  -- 6. confirm：成功 → 账 id = pending id；再 confirm 一次 → 仍 recorded、只有一笔；别人 confirm → gone；
  --    discard 后 confirm → gone；超过 24 小时的 pending → gone
  total := total + 1;
  begin
    perform svc.svc_bot_claim(9000000040, ta);
    perform svc.svc_bot_record(9000000040, ta, 'expense', 1234, 'food', d, 'A', false);
    perform svc.svc_bot_claim(9000000041, ta);
    j := svc.svc_bot_record(9000000041, ta, 'expense', 1234, 'food', d, 'B', false);
    u := (j->'pending'->>'id')::uuid;
    ok := svc.svc_bot_confirm(tb, u)->>'status' = 'gone';
    j := svc.svc_bot_confirm(ta, u);
    ok := ok and j->>'status' = 'recorded' and (j->'tx'->>'id')::uuid = u;
    j2 := svc.svc_bot_confirm(ta, u);
    select count(*) into n from public.transactions where user_id = ua and id = u;
    ok := ok and j2->>'status' = 'recorded' and (j2->'tx'->>'id')::uuid = u and n = 1;
    perform svc.svc_bot_claim(9000000042, ta);
    u2 := (svc.svc_bot_record(9000000042, ta, 'expense', 1234, 'food', d, 'C', false)->'pending'->>'id')::uuid;
    ok := ok and svc.svc_bot_discard(ta, u2) = true and svc.svc_bot_confirm(ta, u2)->>'status' = 'gone';
    perform svc.svc_bot_claim(9000000043, ta);
    u2 := (svc.svc_bot_record(9000000043, ta, 'expense', 1234, 'food', d, 'D', false)->'pending'->>'id')::uuid;
    update private.bot_pending set created_at = now() - interval '25 hours' where id = u2;
    ok := ok and svc.svc_bot_confirm(ta, u2)->>'status' = 'gone';
    if ok then pass := pass + 1; else fails := array_append(fails, ('6 confirm 不对:' || coalesce(j::text, 'null') || ' ' || coalesce(j2::text, 'null'))); end if;
  exception when others then fails := array_append(fails, ('6:' || sqlerrm));
  end;

  -- 7. undo／set_category：别人的账、manual 的账 → not_found；成功 → done；已删除 → already／deleted；
  --    updated_at 比现在晚 4 分钟（手机时钟快）→ 改后 = 旧 + 1 毫秒（M2）；set_category 改 kind
  total := total + 1;
  begin
    u := gen_random_uuid();
    ts := now() + interval '4 minutes';
    insert into public.transactions (user_id, id, kind, amount_minor, category_id, occurred_on, note, created_at, updated_at, source)
    values (ua, u, 'expense', 4321, 'food', d, '', now(), ts, 'bot');
    u2 := gen_random_uuid();
    insert into public.transactions (user_id, id, kind, amount_minor, category_id, occurred_on, note, created_at, updated_at, source)
    values (ua, u2, 'expense', 4322, 'food', d, '', now(), now(), 'manual');
    ok := svc.svc_bot_undo(tb, u)->>'status' = 'not_found'
      and svc.svc_bot_undo(ta, u2)->>'status' = 'not_found'
      and svc.svc_bot_set_category(ta, u2, 'fun', 'expense')->>'status' = 'not_found';
    j := svc.svc_bot_set_category(ta, u, 'salary', 'income');
    ok := ok and j->>'status' = 'done' and j->'tx'->>'kind' = 'income' and j->'tx'->>'category_id' = 'salary'
      and (select updated_at from public.transactions where user_id = ua and id = u) = ts + interval '1 millisecond';
    j := svc.svc_bot_undo(ta, u);
    ok := ok and j->>'status' = 'done' and (j->'tx'->>'deleted')::boolean
      and (select deleted from public.transactions where user_id = ua and id = u);
    ok := ok and svc.svc_bot_undo(ta, u)->>'status' = 'already'
      and svc.svc_bot_set_category(ta, u, 'food', 'expense')->>'status' = 'deleted';
    ok := ok and (svc.svc_bot_tx(ta, u)->>'deleted')::boolean and svc.svc_bot_tx(tb, u) is null and svc.svc_bot_tx(ta, u2) is null;
    if ok then pass := pass + 1; else fails := array_append(fails, ('7 undo／set_category 不对:' || coalesce(j::text, 'null'))); end if;
  exception when others then fails := array_append(fails, ('7:' || sqlerrm));
  end;

  -- 8. ai_reserve：第 31 次 → user；全站满 → site；refund 后又能用；refund 别人的无效；没连接 → gone；上限 0／1001 → raise
  total := total + 1;
  begin
    insert into private.bot_ai_uses (user_id, at) select uc, now() from generate_series(1, 29);
    j := svc.svc_bot_ai_reserve(tc, 30, 1000);
    ok := (j->>'ok')::boolean and svc.svc_bot_ai_reserve(tc, 30, 1000)->>'why' = 'user';
    perform svc.svc_bot_ai_refund(tb, (j->>'use_id')::bigint);  -- 别人的：无效
    ok := ok and svc.svc_bot_ai_reserve(tc, 30, 1000)->>'why' = 'user';
    perform svc.svc_bot_ai_refund(tc, (j->>'use_id')::bigint);
    ok := ok and (svc.svc_bot_ai_reserve(tc, 30, 1000)->>'ok')::boolean;
    n := svc.svc_bot_ai_count();
    ok := ok and n >= 30 and svc.svc_bot_ai_reserve(ta, 1000, n)->>'why' = 'site';
    ok := ok and svc.svc_bot_ai_reserve(tz, 30, 200)->>'why' = 'gone';
    begin perform svc.svc_bot_ai_reserve(ta, 0, 200);    ok := false; exception when raise_exception then null; end;
    begin perform svc.svc_bot_ai_reserve(ta, 30, 1001);  ok := false; exception when raise_exception then null; end;
    if ok then pass := pass + 1; else fails := array_append(fails, ('8 ai_reserve 不对:' || coalesce(j::text, 'null'))); end if;
  exception when others then fails := array_append(fails, ('8:' || sqlerrm));
  end;

  -- 9. categories：回这个人服务器上的分类（含已删除）；没连接 → null
  total := total + 1;
  begin
    insert into public.categories (user_id, id, kind, name, sort, updated_at, deleted)
    values (ua, 'food', 'expense', '吃饭', 0, now(), false), (ua, 'fun', 'expense', '娱乐', 4, now(), true);
    j := svc.svc_bot_categories(ta);
    ok := jsonb_array_length(j) = 2
      and exists (select 1 from jsonb_array_elements(j) e where e->>'id' = 'food' and e->>'name' = '吃饭' and not (e->>'deleted')::boolean)
      and exists (select 1 from jsonb_array_elements(j) e where e->>'id' = 'fun' and (e->>'deleted')::boolean)
      and svc.svc_bot_categories(tz) is null;
    if ok then pass := pass + 1; else fails := array_append(fails, ('9 categories 不对:' || coalesce(j::text, 'null'))); end if;
  exception when others then fails := array_append(fails, ('9:' || sqlerrm));
  end;

  -- 10. 参数不合格 → raise
  total := total + 1;
  begin
    ok := true;
    begin perform svc.svc_bot_claim(0, ta);                                                ok := false; exception when raise_exception then null; end;
    begin perform svc.svc_bot_claim(9000000099, 0);                                       ok := false; exception when raise_exception then null; end;
    begin perform svc.svc_bot_record(9000000099, ta, 'gift', 1, 'food', d, '', false);    ok := false; exception when raise_exception then null; end;
    begin perform svc.svc_bot_record(9000000099, ta, 'expense', 0, 'food', d, '', false); ok := false; exception when raise_exception then null; end;
    begin perform svc.svc_bot_record(9000000099, ta, 'expense', 1, '', d, '', false);     ok := false; exception when raise_exception then null; end;
    begin perform svc.svc_bot_record(9000000099, ta, 'expense', 1, 'food', d, repeat('x', 501), false); ok := false; exception when raise_exception then null; end;
    begin perform svc.svc_bot_set_category(ta, gen_random_uuid(), 'food', 'gift');       ok := false; exception when raise_exception then null; end;
    begin perform svc.svc_bot_confirm(ta, null);                                          ok := false; exception when raise_exception then null; end;
    if ok then pass := pass + 1; else fails := array_append(fails, '10 参数不合格没有 raise'::text); end if;
  exception when others then fails := array_append(fails, ('10:' || sqlerrm));
  end;

  -- 11. 解除连接后：claim → unlinked；undo → not_found；ai_ok_at 跟着连接消失；pending 被清掉
  total := total + 1;
  begin
    perform svc.svc_bot_claim(9000000050, tb);
    u := (svc.svc_bot_record(9000000050, tb, 'expense', 500, 'food', d, '', false)->'pending'->>'id')::uuid;
    u2 := gen_random_uuid();
    insert into public.transactions (user_id, id, kind, amount_minor, category_id, occurred_on, note, created_at, updated_at, source)
    values (ub, u2, 'expense', 8888, 'food', d, '', now(), now(), 'bot');
    perform svc.svc_bot_ai_consent(tb);
    ok := svc.svc_tg_unlink(ub) = true;
    ok := ok and svc.svc_bot_claim(9000000051, tb)->>'do' = 'unlinked'
      and svc.svc_bot_undo(tb, u2)->>'status' = 'not_found'
      and not exists (select 1 from private.bot_pending where user_id = ub);
    insert into private.telegram_links (telegram_id, user_id, kind) values (tb, ub, 'email');
    ok := ok and (svc.svc_bot_claim(9000000052, tb)->>'ai_ok')::boolean = false;
    if ok then pass := pass + 1; else fails := array_append(fails, '11 解除连接后不对'::text); end if;
  exception when others then fails := array_append(fails, ('11:' || sqlerrm));
  end;

  -- 12. svc_delete_user_data 后 3 张表这个人 0 列
  total := total + 1;
  begin
    perform svc.svc_bot_claim(9000000060, tc);
    perform svc.svc_bot_ai_reserve(tc, 1000, 1000);
    perform svc.svc_delete_user_data(uc);
    select count(*) into n from private.bot_updates where user_id = uc;
    select count(*) into n2 from private.bot_ai_uses where user_id = uc;
    ok := n = 0 and n2 = 0 and not exists (select 1 from private.bot_pending where user_id = uc);
    if ok then pass := pass + 1; else fails := array_append(fails, ('12 删号没清干净:' || n || '/' || n2)); end if;
  exception when others then fails := array_append(fails, ('12:' || sqlerrm));
  end;

  -- 13. 已问过、pending 已按掉（confirm）→ claim 回 dup（不再补发问句）；同一 update_id 换另一个 telegram → dup
  total := total + 1;
  begin
    perform svc.svc_bot_claim(9000000080, ta);
    j := svc.svc_bot_record(9000000080, ta, 'expense', 1234, 'food', d, 'E', false);
    ok := j->>'status' = 'asked';
    perform svc.svc_bot_confirm(ta, (j->'pending'->>'id')::uuid);
    ok := ok and svc.svc_bot_claim(9000000080, ta)->>'do' = 'dup';
    perform svc.svc_bot_claim(9000000081, ta);
    ok := ok and svc.svc_bot_claim(9000000081, tb)->>'do' = 'dup';
    if ok then pass := pass + 1; else fails := array_append(fails, ('13 pending 按掉后／换 telegram 不对:' || coalesce(j::text, 'null'))); end if;
  exception when others then fails := array_append(fails, ('13:' || sqlerrm));
  end;

  -- 14. 处理中但已回复过（看不懂、finish 没成功）超过 2 分钟 → dup（不再叫 AI）
  total := total + 1;
  begin
    perform svc.svc_bot_claim(9000000082, ta);
    perform svc.svc_bot_replied(9000000082, ta);
    update private.bot_updates set claimed_at = now() - interval '3 minutes' where update_id = 9000000082;
    j := svc.svc_bot_claim(9000000082, ta);
    ok := j->>'do' = 'dup';
    if ok then pass := pass + 1; else fails := array_append(fails, ('14 已回复的处理中被重领:' || coalesce(j::text, 'null'))); end if;
  exception when others then fails := array_append(fails, ('14:' || sqlerrm));
  end;

  -- 15. refund 超过 5 分钟的不退
  total := total + 1;
  begin
    j := svc.svc_bot_ai_reserve(ta, 1000, 1000);
    update private.bot_ai_uses set at = now() - interval '6 minutes' where id = (j->>'use_id')::bigint;
    perform svc.svc_bot_ai_refund(ta, (j->>'use_id')::bigint);
    ok := exists (select 1 from private.bot_ai_uses where id = (j->>'use_id')::bigint);
    if ok then pass := pass + 1; else fails := array_append(fails, '15 超过 5 分钟还退次数'::text); end if;
  exception when others then fails := array_append(fails, ('15:' || sqlerrm));
  end;

  -- 17.（用户决定 1）相簿里两张一样的大额截图：第二张也比对「还没按的问句」→ asked/similar（similar 是 null）；
  --     不同天、不同收支、超过 24 小时的问句、别人的问句都不算；按掉（discard）后再传 → 回到 big
  total := total + 1;
  begin
    perform svc.svc_bot_claim(9000000100, tb);
    j := svc.svc_bot_record(9000000100, tb, 'expense', 250000, 'shopping', d - 3, '', true);
    perform svc.svc_bot_claim(9000000101, tb);
    j2 := svc.svc_bot_record(9000000101, tb, 'expense', 250000, 'shopping', d - 3, '', true);
    ok := j->>'reason' = 'big' and j2->>'status' = 'asked' and j2->>'reason' = 'similar'
      and coalesce(j2->'similar', 'null'::jsonb) = 'null'::jsonb and j2->'pending'->>'id' <> j->'pending'->>'id';
    perform svc.svc_bot_claim(9000000102, tb);
    ok := ok and svc.svc_bot_record(9000000102, tb, 'expense', 250000, 'shopping', d - 4, '', true)->>'reason' = 'big';
    perform svc.svc_bot_claim(9000000103, tb);
    ok := ok and svc.svc_bot_record(9000000103, tb, 'income', 250000, 'side', d - 3, '', true)->>'reason' = 'big';
    perform svc.svc_bot_claim(9000000104, ta);
    ok := ok and svc.svc_bot_record(9000000104, ta, 'expense', 250000, 'shopping', d - 3, '', true)->>'reason' = 'big';
    perform svc.svc_bot_discard(tb, (j->'pending'->>'id')::uuid);
    perform svc.svc_bot_discard(tb, (j2->'pending'->>'id')::uuid);
    -- 先 claim 再插 25 小时前的问句（claim 会顺手清掉超过 24 小时的，插在前面就测不到 record 自己的时间条件；最终审核 N2）
    perform svc.svc_bot_claim(9000000105, tb);
    insert into private.bot_pending (id, user_id, telegram_id, reason, kind, amount_minor, category_id, occurred_on, created_at)
    values (gen_random_uuid(), ub, tb, 'big', 'expense', 250000, 'shopping', d - 3, now() - interval '25 hours');
    ok := ok and svc.svc_bot_record(9000000105, tb, 'expense', 250000, 'shopping', d - 3, '', true)->>'reason' = 'big';
    if ok then pass := pass + 1; else fails := array_append(fails, ('17 问句没算进相似:' || coalesce(j::text, 'null') || ' ' || coalesce(j2::text, 'null'))); end if;
  exception when others then fails := array_append(fails, ('17:' || sqlerrm));
  end;

  -- 16.（放最后，会改 ta 的连接）领取后换了连接的账号 → record 回 gone、没写账（M4）
  total := total + 1;
  begin
    perform svc.svc_bot_claim(9000000090, ta);
    delete from private.telegram_links where telegram_id = ta;
    insert into private.telegram_links (telegram_id, user_id, kind) values (ta, ud, 'email');
    j := svc.svc_bot_record(9000000090, ta, 'expense', 7777, 'food', d, '', false);
    ok := j->>'status' = 'gone' and not exists (select 1 from public.transactions where amount_minor = 7777 and user_id in (ua, ud));
    if ok then pass := pass + 1; else fails := array_append(fails, ('16 换账号后还记账:' || coalesce(j::text, 'null'))); end if;
  exception when others then fails := array_append(fails, ('16:' || sqlerrm));
  end;

  raise exception 'VERIFY 3d: % / % PASS。失败: %', pass, total,
    case when cardinality(fails) = 0 then '无' else array_to_string(fails, '；') end;
end
$$;
