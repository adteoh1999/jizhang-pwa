-- 2e-3：Realtime 门铃（js/realtime.js）。可以重复执行。
-- 只发布 INSERT / UPDATE：Realtime 的 DELETE 事件不过 RLS（官方 postgres-changes 文件），
-- 账号删除的 on delete cascade 会把别人的 user_id、id 推给所有连线中的人。App 只做软删除（deleted 栏位，是 UPDATE）。
-- 注意：supabase_realtime 是整个专案共用的 publication，这个设定对里面所有表都有效（目前只有下面两张）。
alter publication supabase_realtime set (publish = 'insert, update');

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'transactions') then
    alter publication supabase_realtime add table public.transactions;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'categories') then
    alter publication supabase_realtime add table public.categories;
  end if;
end $$;
