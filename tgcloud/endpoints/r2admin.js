import { EndpointError } from 'sdk';
import { enterAdmin, pickOp } from '../lib/appctx.js';
import * as A from '../lib/r2admin.js';
import { listTopics } from '../lib/forum.js';

// Админка 2 тура. Каждый вызов проверяет, что пользователь — владелец (по подписи Telegram / сессии, не по данным клиента).
const OPS = {
  overview: () => A.overview(),
  setCfg: (u, i) => A.setCfg(i),
  accessList: () => A.accessList().then((items) => ({ items })),
  accessAdd: (u, i) => A.accessAdd(i.text, u.id),
  accessRemove: (u, i) => A.accessRemove(i.id).then(() => ({ ok: true })),
  searchUsers: (u, i) => A.searchUsers(i.q).then((items) => ({ items })),
  noms: () => A.adminNominations().then((items) => ({ items })),
  projects: (u, i) => A.adminProjects(i.nominationId).then((items) => ({ items })),
  saveProject: (u, i) => A.saveProject(i),
  deleteProject: (u, i) => A.deleteProject(i.id),
  moveProject: (u, i) => A.moveProject(i.id, i.dir === 'up' ? 'up' : 'down'),
  toggleChoice: (u, i) => A.toggleChoice(i.id),
  results: (u, i) => A.results(i.nominationId).then((items) => ({ items })),
  resultsText: () => A.resultsText().then((text) => ({ text })),
  suspicious: () => A.suspicious().then((items) => ({ items })),
  exclude: (u, i) => A.setExcluded(i.userId, !!i.excluded, i.reason),
  resetVotes: (u, i) => A.resetVotes(i.userId),
  drawings: (u, i) => A.adminDrawings(i.before),
  deleteDrawing: (u, i) => A.deleteDrawing(i.id).then(() => ({ ok: true })),
  posts: (u, i) => A.adminPosts(i.filter).then((items) => ({ items })),
  hidePost: (u, i) => A.setPostHidden(i.id, !!i.hidden).then(() => ({ ok: true })),
  mute: (u, i) => A.adminMute(i.userId, Number(i.minutes) || 0, i.reason),
  topics: () => listTopics().then((items) => ({ items })),
  saveTopic: (u, i) => A.saveTopic(i),
  deleteTopic: (u, i) => A.deleteTopic(i.id).then(() => ({ ok: true })),
};

export default async function (input, ctx) {
  const user = await enterAdmin(ctx);
  const fn = pickOp(OPS, input?.op);
  if (!fn) throw new EndpointError('Неизвестное действие', { code: 'BAD' });
  return fn(user, input || {});
}
