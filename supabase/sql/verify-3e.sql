-- 记账 App · 3e 的检查（bot 读用户关键词：svc_bot_keywords）
-- 用法：supabase db query --remote -f supabase/sql/verify-3e.sql --yes（或贴到 SQL Editor 按 Run）。
-- 结果：一定会出现一个「错误」，内容是 VERIFY 3e: 通过数 / 总数 PASS。
--       这是故意的：用错误结束，脚本里建的临时用户、连接、关键词会全部自动撤回，不留垃圾。
-- 每一项都包在自己的 begin … exception 里：某一项出错只记成失败，其他项照样检查。
-- 测试用 Telegram id 用 5000000511 起的假号段。

do $$
declare
  ua uuid := '00000000-0000-4000-8000-0000000003e1';  -- 主角
  ub uuid := '00000000-0000-4000-8000-0000000003e2';  -- 别人
  ta bigint := 5000000511;
  tb bigint := 5000000512;
  tz bigint := 5000000519;  -- 没有连接
  pass  int := 0;
  total int := 0;
  fails text[] := '{}';
  ok  boolean;
  v   text;
  j   jsonb;
  f   text := 'svc.svc_bot_keywords(bigint)';
  ts  timestamptz := now() - interval '1 minute';
begin
  insert into auth.users (instance_id, id, aud, role, email, raw_app_meta_data)
  values ('00000000-0000-0000-0000-000000000000', ua, 'authenticated', 'authenticated', 'ua3e@test.invalid', '{"kind":"email"}'),
         ('00000000-0000-0000-0000-000000000000', ub, 'authenticated', 'authenticated', 'ub3e@test.invalid', '{"kind":"email"}');
  insert into private.telegram_links (telegram_id, user_id, kind) values (ta, ua, 'email'), (tb, ub, 'email');
  insert into public.category_keywords (user_id, keyword, category_id, updated_at, deleted) values
    (ua, 'mrt', 'transport', ts, false),
    (ua, 'grab', 'transport', ts, false),
    (ua, '猫粮', 'shopping', ts, false),
    (ua, 'a"b,c(d)%+😀', 'other', ts, false),
    (ua, 'old', 'food', ts, true),
    (ub, 'netflix', 'fun', ts, false);

  -- 1. 函数在、security definer、search_path = ''、stable（只读）；anon／authenticated 不能执行、service_role 能
  total := total + 1;
  begin
    v := '';
    if not exists (select 1 from pg_proc p where p.oid = to_regprocedure(f)
                    and p.prosecdef and p.provolatile = 's' and 'search_path=""' = any(coalesce(p.proconfig, '{}'))) then
      v := v || '设定不对 ';
    end if;
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then v := v || '开放 '; end if;
    if not has_function_privilege('service_role', f, 'execute') then v := v || 'service_role 不能用 '; end if;
    ok := v = '';
    if ok then pass := pass + 1; else fails := array_append(fails, ('1 函数／权限:' || v)); end if;
  exception when others then fails := array_append(fails, ('1:' || sqlerrm));
  end;

  -- 2. 只回自己的、没删除的；按关键词排序；形状只有 keyword、category_id（特殊字元原样）
  total := total + 1;
  begin
    j := svc.svc_bot_keywords(ta);
    ok := jsonb_typeof(j) = 'array' and jsonb_array_length(j) = 4
      and (select array_agg(e->>'keyword' order by ord) from jsonb_array_elements(j) with ordinality as x(e, ord))
          = (select array_agg(k order by k) from unnest(array['mrt', 'grab', '猫粮', 'a"b,c(d)%+😀']) k)
      and not exists (select 1 from jsonb_array_elements(j) e where (select count(*) from jsonb_object_keys(e)) <> 2)
      and exists (select 1 from jsonb_array_elements(j) e where e->>'keyword' = 'grab' and e->>'category_id' = 'transport')
      and not exists (select 1 from jsonb_array_elements(j) e where e->>'keyword' in ('old', 'netflix'));
    if ok then pass := pass + 1; else fails := array_append(fails, ('2 回传不对:' || coalesce(j::text, 'null'))); end if;
  exception when others then fails := array_append(fails, ('2:' || sqlerrm));
  end;

  -- 3. 没连接 → null；别人只看到自己的
  total := total + 1;
  begin
    j := svc.svc_bot_keywords(tb);
    ok := svc.svc_bot_keywords(tz) is null
      and jsonb_array_length(j) = 1 and j->0->>'keyword' = 'netflix';
    if ok then pass := pass + 1; else fails := array_append(fails, ('3 没连接或别人的不对:' || coalesce(j::text, 'null'))); end if;
  exception when others then fails := array_append(fails, ('3:' || sqlerrm));
  end;

  -- 4. telegram_id 不合格 → 错误
  total := total + 1;
  begin
    begin
      perform svc.svc_bot_keywords(0);
      ok := false;
    exception when others then ok := true;
    end;
    begin
      perform svc.svc_bot_keywords(null);
      ok := false;
    exception when others then ok := ok and true;
    end;
    if ok then pass := pass + 1; else fails := array_append(fails, '4 不合格的 telegram_id 没被挡'); end if;
  exception when others then fails := array_append(fails, ('4:' || sqlerrm));
  end;

  -- 5. 最多 500 个
  total := total + 1;
  begin
    insert into public.category_keywords (user_id, keyword, category_id, updated_at)
      select ub, 'k' || lpad(g::text, 4, '0'), 'food', ts from generate_series(1, 600) g;
    ok := jsonb_array_length(svc.svc_bot_keywords(tb)) = 500;
    if ok then pass := pass + 1; else fails := array_append(fails, '5 没有限制 500 个'); end if;
  exception when others then fails := array_append(fails, ('5:' || sqlerrm));
  end;

  raise exception 'VERIFY 3e: % / % PASS。失败: %', pass, total,
    case when cardinality(fails) = 0 then '无' else array_to_string(fails, '；') end;
end
$$;
