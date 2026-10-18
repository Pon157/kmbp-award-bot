import * as S from '../lib/store.js';

// Узнаём, что пользователь заблокировал бота (или вернулся) — чтобы рассылка не била в пустоту.
export default async function (upd) {
  if (upd.chat?.type !== 'private') return;
  const status = upd.new_chat_member?.status;
  if (status === 'kicked') await S.setBlocked(upd.chat.id, true);
  else if (status === 'member') await S.setBlocked(upd.chat.id, false);
}
