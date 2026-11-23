// Supabase 连线设定。这里只能放公开的 publishable key（只放在 apikey header）；
// secret key、Resend key 等绝不能出现在前端（tests/auth.test.js 会检查）。
export const SUPABASE_URL = 'https://xzsjdqtrdfbiotypooet.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_fDAq67NruV3kBXPcdebKaA_ujun8vU5';
export const REGISTER_URL = `${SUPABASE_URL}/functions/v1/register`;
