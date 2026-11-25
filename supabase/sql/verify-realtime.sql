-- 2e-3：检查 Realtime 发布设定（只读）。每列 PASS / FAIL。
select 'publication 只发 insert、update' as check_name,
  case when pubinsert and pubupdate and not pubdelete and not pubtruncate and not puballtables then 'PASS' else 'FAIL' end as result
from pg_publication where pubname = 'supabase_realtime'
union all
select 'transactions 在 publication 里',
  case when exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'transactions') then 'PASS' else 'FAIL' end
union all
select 'categories 在 publication 里',
  case when exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'categories') then 'PASS' else 'FAIL' end
union all
select 'publication 里只有这两张表',
  case when (select count(*) from pg_publication_tables where pubname = 'supabase_realtime') = 2 then 'PASS' else 'FAIL' end
union all
select 'RLS 开着（transactions、categories）',
  case when (select bool_and(relrowsecurity) from pg_class where oid in ('public.transactions'::regclass, 'public.categories'::regclass)) then 'PASS' else 'FAIL' end;
