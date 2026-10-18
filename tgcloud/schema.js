import { table, integer, text, boolean, index, uniqueIndex } from 'sdk/db';

// Telegram-пользователи, которых мы видели (бот или мини-апп).
export const users = table('users', {
  id:        integer('id').primaryKey(),               // Telegram user id
  username:  text('username'),
  firstName: text('first_name'),
  lastName:  text('last_name'),
  started:   boolean('started').notNull().default(false), // писал боту /start — можно слать рассылку
  blocked:   boolean('blocked').notNull().default(false), // заблокировал бота
  firstSeen: integer('first_seen').notNull().default(0),
  lastSeen:  integer('last_seen').notNull().default(0),
}, (t) => ({
  usernameIdx: index('idx_users_username').on(t.username),
}));

// Владельцы, добавленные из админ-панели (плюс OWNER_IDS из lib/config.js).
export const owners = table('owners', {
  userId:  integer('user_id').primaryKey(),
  addedBy: integer('added_by'),
  addedAt: integer('added_at').notNull().default(0),
});

// Баны. scope: all — везде, bot — только бот, app — только мини-апп.
export const bans = table('bans', {
  userId: integer('user_id').primaryKey(),
  scope:  text('scope').notNull().default('all'),
  reason: text('reason'),
  byId:   integer('by_id'),
  at:     integer('at').notNull().default(0),
});

// Номинации. kind: bot | project | person | event.
export const nominations = table('nominations', {
  id:       integer('id').primaryKey({ autoIncrement: true }),
  title:    text('title').notNull(),
  kind:     text('kind').notNull().default('project'),
  sponsorType: text('sponsor_type'),                         // person | bot | project для подноминаций спонсоров
  sponsorOnly: boolean('sponsor_only').notNull().default(false),
  emojiId:  text('emoji_id'),                              // премиум-эмодзи для кнопки
  isOpen:   boolean('is_open').notNull().default(true),
  active:   boolean('active').notNull().default(true),     // false = удалена
  position: integer('position').notNull().default(0),
  createdAt: integer('created_at').notNull().default(0),
}, (t) => ({
  sponsorTypeIdx: uniqueIndex('uq_nominations_sponsor_type').on(t.sponsorType),
}));

// Дополнительные вопросы к номинации в мини-аппе.
export const questions = table('questions', {
  id:           integer('id').primaryKey({ autoIncrement: true }),
  nominationId: integer('nomination_id').notNull(),
  text:         text('text').notNull(),
  required:     boolean('required').notNull().default(false),
  maxLen:       integer('max_len').notNull().default(500),
  active:       boolean('active').notNull().default(true),
  position:     integer('position').notNull().default(0),
}, (t) => ({
  nomIdx: index('idx_questions_nom').on(t.nominationId),
}));

// Заявки. Один человек — одна заявка в номинации (uq), в режиме global — одна на всё.
export const applications = table('applications', {
  id:           integer('id').primaryKey({ autoIncrement: true }),
  nominationId: integer('nomination_id').notNull(),
  userId:       integer('user_id').notNull(),
  title:        text('title').notNull(),
  username:     text('username').notNull(),
  usernameNorm: text('username_norm').notNull(),
  description:  text('description').notNull(),
  answers:      text('answers').notNull().default('{}'),   // JSON {questionId: text}
  adminChatId:  integer('admin_chat_id'),
  adminMsgId:   integer('admin_msg_id'),
  sponsorNominationId: integer('sponsor_nomination_id'),   // голос ушёл в спонсорскую номинацию (юзернейм совпал с записью спонсора)
  createdAt:    integer('created_at').notNull().default(0),
  updatedAt:    integer('updated_at').notNull().default(0),
}, (t) => ({
  uq:      uniqueIndex('uq_app_user_nom').on(t.userId, t.nominationId),
  normIdx: index('idx_app_norm').on(t.nominationId, t.usernameNorm),
  usernameGlobalIdx: index('idx_app_username_norm').on(t.usernameNorm),
}));

// Новости для лендинга: текст + Telegram-entities (все виды форматирования).
export const news = table('news', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  text:      text('text').notNull(),
  entities:  text('entities').notNull().default('[]'),
  pinned:    boolean('pinned').notNull().default(false),
  createdBy: integer('created_by'),
  createdAt: integer('created_at').notNull().default(0),
});

// Ссылки на ресурсы проекта для лендинга.
export const links = table('links', {
  id:       integer('id').primaryKey({ autoIncrement: true }),
  title:    text('title').notNull(),
  url:      text('url').notNull(),
  kind:     text('kind').notNull().default('other'),
  position: integer('position').notNull().default(0),
});

// Настройки (ключ-значение).
export const settings = table('settings', {
  key:   text('key').primaryKey(),
  value: text('value'),
});

// Состояние диалога админа (пошаговые сценарии в боте).
export const states = table('states', {
  userId:    integer('user_id').primaryKey(),
  state:     text('state').notNull(),
  data:      text('data').notNull().default('{}'),
  updatedAt: integer('updated_at').notNull().default(0),
});

// Рассылки: идут пачками, курсор хранится в таблице.
export const broadcasts = table('broadcasts', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  fromChat:  integer('from_chat').notNull(),
  messageId: integer('message_id').notNull(),
  createdBy: integer('created_by'),
  status:    text('status').notNull().default('draft'),     // draft | running | done | cancelled
  cursor:    integer('cursor').notNull().default(0),        // последний обработанный user id
  total:     integer('total').notNull().default(0),
  sent:      integer('sent').notNull().default(0),
  failed:    integer('failed').notNull().default(0),
  statusChat: integer('status_chat'),
  statusMsg:  integer('status_msg'),
  createdAt: integer('created_at').notNull().default(0),
});

// Допуск в спонсорские подноминации задаётся по username Telegram-аккаунта.
export const sponsors = table('sponsors', {
  id:           integer('id').primaryKey({ autoIncrement: true }),
  username:     text('username').notNull(),
  usernameNorm: text('username_norm').notNull(),
  addedBy:      integer('added_by'),
  addedAt:      integer('added_at').notNull().default(0),
}, (t) => ({
  usernameNormUq: uniqueIndex('uq_sponsors_username_norm').on(t.usernameNorm),
}));

// Рекламные баннеры спонсоров. Изображение выдаётся отдельным endpoint'ом.
export const sponsorBanners = table('sponsor_banners', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  title:     text('title').notNull(),
  targetUrl: text('target_url').notNull(),
  imageData: text('image_data').notNull(),
  active:    boolean('active').notNull().default(true),
  position:  integer('position').notNull().default(0),
  createdAt: integer('created_at').notNull().default(0),
});

// Монеты: журнал начислений (+) и трат (−). Баланс = сумма amount.
// Уникальность (user_id, reason) делает начисление идемпотентным: одну награду нельзя получить дважды.
export const coinLog = table('coin_log', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  userId:    integer('user_id').notNull(),
  amount:    integer('amount').notNull(),
  reason:    text('reason').notNull(),            // all_nominations | r2vote:<id> | …
  createdAt: integer('created_at').notNull().default(0),
}, (t) => ({
  uq:      uniqueIndex('uq_coin_user_reason').on(t.userId, t.reason),
  userIdx: index('idx_coin_user').on(t.userId),
}));

// Напоминания «вы проголосовали не во всех номинациях».
export const reminders = table('reminders', {
  userId: integer('user_id').primaryKey(),
  lastAt: integer('last_at').notNull().default(0),
  count:  integer('count').notNull().default(0),
  muted:  boolean('muted').notNull().default(false),
});

// Рефералы: кто кого пригласил. Реферал засчитывается, только когда приглашённый подал хотя бы одну заявку —
// это считается на лету (EXISTS по applications), поэтому удалённые админом фейковые заявки сразу уменьшают счёт.
export const referrals = table('referrals', {
  userId:     integer('user_id').primaryKey(),          // приглашённый
  referrerId: integer('referrer_id').notNull(),          // пригласивший
  createdAt:  integer('created_at').notNull().default(0),
}, (t) => ({
  byReferrer: index('idx_ref_referrer').on(t.referrerId),
}));
