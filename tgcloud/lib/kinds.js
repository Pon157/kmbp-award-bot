// Типы номинаций и подписи полей формы.
export const KINDS = {
  bot: {
    name: 'Бот', adminName: 'Бот',
    titleLabel: 'Название бота', usernameLabel: 'Юзернейм бота', descLabel: 'Описание бота',
    titleHint: 'Как называется бот', usernameHint: 'username_bot',
    descHint: 'Чем бот помогает, что в нём особенного и почему он достоин премии',
  },
  project: {
    name: 'Проект', adminName: 'Проект',
    titleLabel: 'Название проекта', usernameLabel: 'Юзернейм проекта', descLabel: 'Описание проекта',
    titleHint: 'Как называется проект', usernameHint: 'username канала, чата или бота',
    descHint: 'Что это за проект, чем он полезен сообществу и почему он достоин премии',
  },
  person: {
    name: 'Личность', adminName: 'Личность',
    titleLabel: 'Имя или псевдоним', usernameLabel: 'Юзернейм человека', descLabel: 'О человеке',
    titleHint: 'Как зовут номинанта', usernameHint: 'username в Telegram',
    descHint: 'Что сделал этот человек для сообщества и почему он достоин премии',
  },
  event: {
    name: 'Событие', adminName: 'Событие',
    titleLabel: 'Название события', usernameLabel: 'Юзернейм организатора', descLabel: 'Описание события',
    titleHint: 'Как называлось событие', usernameHint: 'username организатора или канала',
    descHint: 'Что это было за событие, когда прошло и почему оно запомнилось',
  },
};
export const kindOf = (k) => KINDS[k] || KINDS.project;
export const KIND_KEYS = Object.keys(KINDS);

export const DEFAULT_KIND_EMOJI = {
  bot: '5785195865379442415',
  project: '5857290546459973028',
  person: '6008353471202333128',
  event: '5785363566672482185',
};
