import { EndpointError } from 'sdk';
import * as S from '../lib/store.js';
import { enter } from '../lib/appctx.js';
import { kindOf } from '../lib/kinds.js';
import { LIMITS } from '../lib/config.js';

const parse = (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } };

export default async function (input, ctx) {
  const user = await enter(ctx);
  const nom = await S.getNomination(Number(input?.id));
  if (!nom) throw new EndpointError('Номинация не найдена', { code: 'NOT_FOUND' });
  if (nom.sponsor_only && !(await S.isSponsor(user.username))) {
    throw new EndpointError('Эта подноминация доступна только указанным спонсорам', { code: 'SPONSOR_ONLY' });
  }
  const k = kindOf(nom.kind);
  const [qs, mine, open, mode] = await Promise.all([
    S.listQuestions(nom.id), S.userApplication(user.id, nom.id), S.getSetting('apps_open', '1'), S.getSetting('limit_mode', 'nomination'),
  ]);

  let blockedBy = null;
  if (!nom.sponsor_only && !mine && mode === 'global') {
    const any = (await S.userApplications(user.id))[0];
    if (any) blockedBy = any.nomination_title;
  }
  const sponsorNom = mine?.sponsor_nomination_id ? await S.getNomination(mine.sponsor_nomination_id) : null;
  return {
    id: nom.id, title: nom.title, kind: nom.kind, sponsorType: nom.sponsor_type || null,
    open: !!nom.is_open && open === '1',
    blockedBy,
    labels: { title: k.titleLabel, username: k.usernameLabel, description: k.descLabel, titleHint: k.titleHint, usernameHint: k.usernameHint, descHint: k.descHint },
    limits: LIMITS,
    questions: qs.map((q) => ({ id: q.id, text: q.text, required: !!q.required, maxLen: q.max_len })),
    mine: mine ? {
      title: mine.title, username: mine.username, description: mine.description, answers: parse(mine.answers, {}),
      sponsorNomination: sponsorNom ? { id: sponsorNom.id, title: sponsorNom.title } : null,
    } : null,
  };
}
