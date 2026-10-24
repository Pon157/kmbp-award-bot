import { EndpointError } from 'sdk';
import { enterR2, pickOp } from '../lib/appctx.js';
import * as F from '../lib/forum.js';
import { getCfg } from '../lib/r2.js';
import { limit } from '../lib/sec.js';

const OPS = {
  topics: async () => ({ topics: await F.listTopics(), enabled: (await getCfg()).forum }),
  posts: (u, i) => { limit(`f:read:${u.id}`, 40, 60, 'Слишком частые запросы.'); return F.listPosts(u, { topicId: i.topicId, after: Number(i.after) || 0, before: Number(i.before) || 0 }); },
  post: (u, i, req) => F.post(u, i, req),
  report: (u, i) => F.report(u, i.postId),
  del: (u, i) => F.deleteOwn(u, i.postId),
};

export default async function (input, ctx) {
  const { user, req } = await enterR2(ctx);
  const fn = pickOp(OPS, input?.op);
  if (!fn) throw new EndpointError('Неизвестное действие', { code: 'BAD' });
  return fn(user, input || {}, req);
}
