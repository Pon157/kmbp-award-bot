import { EndpointError } from 'sdk';
import { enterR2, pickOp } from '../lib/appctx.js';
import * as R from '../lib/r2.js';
import { makeTicket } from '../lib/sec.js';
import { all, val } from '../lib/db.js';
import { now } from '../lib/util.js';

// Все действия 2 тура для участников: input.op выбирает действие.
const OPS = {
  home: (u) => R.homeState(u),
  nom: (u, i) => R.nominationView(u, i.nominationId),
  ticket: async (u, i) => {
    const n = Number(i.nominationId);
    const until = Number(await val('SELECT until FROM r2_human WHERE user_id = :u', { u: u.id })) || 0;
    return { ticket: makeTicket(u.id, n), needHuman: until <= now() };
  },
  captcha: (u) => R.humanChallenge(u),
  vote: (u, i, req) => R.castMain(u, i, req),
  extra: (u, i, req) => R.castExtra(u, i, req),
  draw: (u, i) => R.saveDrawing(u, i),
  drawDel: (u, i) => R.deleteOwnDrawing(u, i.nominationId),
  drawings: (u, i) => R.listDrawings(u, i.projectId, i.before),
  mine: async (u) => ({   // «мои голоса» для меню «Поменять голос» / «Дополнительный голос»
    votes: await all(`SELECT v.nomination_id, v.project_id, v.kind, v.changes, v.updated_at, p.title AS project, n.title AS nomination
      FROM r2_votes v JOIN r2_projects p ON p.id = v.project_id JOIN nominations n ON n.id = v.nomination_id WHERE v.user_id = :u AND p.active = 1 ORDER BY n.position, n.id`, { u: u.id }),
  }),
};

export default async function (input, ctx) {
  const { user, req } = await enterR2(ctx);
  const fn = pickOp(OPS, input?.op);
  if (!fn) throw new EndpointError('Неизвестное действие', { code: 'BAD' });
  return fn(user, input || {}, req);
}
