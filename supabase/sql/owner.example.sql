-- 记账 App · 设定站主邮箱（范本）
-- 用法：复制下面这一行到 Supabase SQL Editor，把「你的邮箱」换成你自己的邮箱，按 Run。
-- 站主邮箱只存在 Supabase 后台，不要写进这个文件、不要提交到 GitHub。
-- 可以重复执行；大小写和前后空白会自动处理。

insert into private.owner_emails (email) values (lower(btrim('你的邮箱'))) on conflict do nothing;

-- 检查有没有设好（应该看到一列）：
-- select * from private.owner_emails;
