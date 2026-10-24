// Связка сервера с кодом 2 тура: проверка сессии браузера и выдача баннеров. Вызывается из index.mjs (и из тестов).
export async function makeHooks() {
  const { resolveSession } = await import('../tgcloud/lib/weblogin.js');
  const { bannerBytes } = await import('../tgcloud/lib/r2admin.js');
  return { resolveSession, media: (kind, id, v, s) => (kind === 'p' ? bannerBytes(id, v, s) : null) };
}
