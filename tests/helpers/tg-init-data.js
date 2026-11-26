// 测试用：照 Telegram 官方算法签一份 initData（https://core.telegram.org/bots/webapps）
// secret_key = HMAC_SHA256(key="WebAppData", msg=botToken)
// hash = hex(HMAC_SHA256(key=secret_key, msg=data_check_string))
// data_check_string：除 hash 外全部栏位，按 key 排序，key=value，以 \n 连接
// 输出时故意不照字母顺序（user、query_id、auth_date、signature、其他、最后 hash），
// 这样实作若忘了排序，测试才抓得到。
import { createHmac } from 'node:crypto';

const OUTPUT_ORDER = ['user', 'query_id', 'auth_date', 'signature'];

export function signInitData(fields, botToken) {
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  const keys = [
    ...OUTPUT_ORDER.filter((k) => k in fields),
    ...Object.keys(fields).filter((k) => !OUTPUT_ORDER.includes(k)),
  ];
  const p = new URLSearchParams();
  for (const k of keys) p.append(k, fields[k]);
  p.append('hash', hash);
  return p.toString();
}
