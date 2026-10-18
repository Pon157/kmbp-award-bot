// Небольшая модель документа: один и тот же текст рендерится
// как rich-сообщение (sendRichMessage) и как обычный HTML (запасной вариант).
// Внутри блоков — готовый inline-HTML (<b>, <i>, <a>, <code>, <tg-emoji>), пользовательский текст экранируется через esc().
export const D = {
  h:    (x) => ({ t: 'h', x }),
  p:    (x) => ({ t: 'p', x }),
  ul:   (items) => ({ t: 'ul', items }),
  ol:   (items) => ({ t: 'ol', items }),
  q:    (x) => ({ t: 'q', x }),
  hr:   () => ({ t: 'hr' }),
  img:  (url) => ({ t: 'img', url }),
  photo: (fileId, id = 'banner') => ({ t: 'photo', fileId, id }), // картинка из Telegram по file_id
  more: (summary, x) => ({ t: 'more', summary, x }),
};

export function toRich(blocks) {
  return blocks.map((b) => {
    switch (b.t) {
      case 'h':    return `<h3>${b.x}</h3>`;
      case 'p':    return `<p>${b.x.replace(/\n/g, '<br/>')}</p>`;
      case 'ul':   return `<ul>${b.items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
      case 'ol':   return `<ol>${b.items.map((i) => `<li>${i}</li>`).join('')}</ol>`;
      case 'q':    return `<blockquote>${b.x.replace(/\n/g, '<br/>')}</blockquote>`;
      case 'hr':   return '<hr/>';
      case 'img':  return `<img src="${b.url}"/>`;
      case 'photo': return `<img src="tg://photo?id=${b.id}"/>`;
      case 'more': return `<details><summary>${b.summary}</summary><p>${b.x.replace(/\n/g, '<br/>')}</p></details>`;
      default:     return '';
    }
  }).join('');
}

// Медиа, на которое ссылается html через tg://photo?id=…
export const richMedia = (blocks) => blocks.filter((b) => b.t === 'photo')
  .map((b) => ({ id: b.id, media: { type: 'photo', media: b.fileId } }));

export function toClassic(blocks) {
  const parts = [];
  for (const b of blocks) {
    switch (b.t) {
      case 'h':    parts.push(`<b>${b.x}</b>`); break;
      case 'p':    parts.push(b.x); break;
      case 'ul':   parts.push(b.items.map((i) => `• ${i}`).join('\n')); break;
      case 'ol':   parts.push(b.items.map((i, n) => `${n + 1}. ${i}`).join('\n')); break;
      case 'q':    parts.push(`<blockquote>${b.x}</blockquote>`); break;
      case 'hr':   parts.push('· · ·'); break;
      case 'more': parts.push(`<b>${b.summary}</b>\n<blockquote expandable>${b.x}</blockquote>`); break;
      default: break; // img — только в rich
    }
  }
  return parts.join('\n\n');
}
