import sys; import os; sys.path.insert(0, os.path.dirname(__file__))
from uilib import *
import re
from playwright.sync_api import sync_playwright
def shot(pg,n,full=False): pg.screenshot(path=f'/tmp/kmbp-shots/{n}.png', full_page=full)
with sync_playwright() as p:
    b=p.chromium.launch()
    # 1. браузерный вход
    ctx=b.new_context(viewport={'width':430,'height':800}); pg=ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(('pageerror',str(e))))
    pg.goto(BASE+'/'); pg.wait_for_selector('.login'); shot(pg,'40_login')
    pg.click('text=Войти через Telegram'); pg.wait_for_selector('.code'); pg.wait_for_timeout(300); shot(pg,'41_code')
    code=pg.locator('.code').inner_text().strip(); href=pg.locator('a.btn--gold').get_attribute('href'); nonce=href.split('login_')[1]
    print('code',code,'href',href[:40])
    print('bot says:', get(f'/__test/botconfirm?uid=2002&nonce={nonce}&code={code}'))
    pg.wait_for_selector('.hero', timeout=9000); print('logged in as:', pg.locator('.hero__lead').inner_text()[:20])
    print('cookie httponly:', [(c['name'], c['httpOnly'], c['sameSite']) for c in ctx.cookies()])
    print('js can read cookie:', repr(pg.evaluate('document.cookie')))
    pg.reload(); pg.wait_for_selector('.hero'); print('session survives reload: ok')
    ctx.close()
    # 2. нет доступа
    ctx,pg=tgpage(b,2005); pg.goto(BASE+'/'); pg.wait_for_url('**/r1/**', timeout=8000); pg.wait_for_selector('#app *', timeout=8000); pg.wait_for_timeout(1200)
    print('no access -> round 1:', pg.url.replace(BASE,''), '| app children:', pg.evaluate("document.querySelector('#app').children.length"), '| burger(new):', pg.locator('.burger').count()); shot(pg,'42_round1')
    r1err=[e for e in errors if e[0]=='pageerror']; print('r1 page errors:', r1err)
    r=pg.evaluate("fetch('/api/r2',{method:'POST',headers:{'content-type':'application/json','x-init-data':window.Telegram.WebApp.initData},body:JSON.stringify({op:'home'})}).then(r=>r.json())"); print('gate api:', r['parameters']['code'])
    ctx.close()
    # 3. админ на десктопе
    ctx,pg=tgpage(b,9001,1280,860); pg.goto(BASE+'/'); pg.wait_for_selector('.hero'); shot(pg,'43_desk_home')
    pg.click('.burger'); pg.wait_for_selector('.drawer'); pg.wait_for_timeout(300); shot(pg,'44_desk_menu')
    pg.click('text=Админ-панель'); pg.wait_for_selector('.kpis'); pg.wait_for_timeout(300); shot(pg,'45_admin_overview')
    pg.click('.tab >> text=Доступ'); pg.wait_for_selector('textarea'); pg.fill('textarea','2005 @u2003 ghost'); pg.click('button:has-text("Добавить")'); pg.wait_for_timeout(700); print('access toast:', pg.locator('.toast').all_inner_texts()); shot(pg,'46_admin_access')
    pg.click('.tab >> text=Проекты'); pg.wait_for_selector('.arow'); pg.wait_for_timeout(500); shot(pg,'47_admin_projects')
    pg.click('text=Добавить карточку'); pg.wait_for_selector('.sheet'); pg.fill('.sheet input[maxlength="80"]','Новый проект'); pg.fill('.sheet textarea','Описание нового проекта для проверки загрузки.')
    pg.set_input_files('.sheet input[type=file]','' + os.path.join(os.path.dirname(__file__), '..', 'fixtures') + '/b3.jpg'); pg.wait_for_selector('.banner-prev:not(.hide)', timeout=8000)
    pg.click('.sheet .tog'); shot(pg,'48_admin_editor'); pg.click('.sheet .btn--gold'); pg.wait_for_timeout(900); print('save toast:', pg.locator('.toast').all_inner_texts(), 'rows', pg.locator('.arow').count())
    pg.click('.tab >> text=Результаты'); pg.wait_for_selector('.res'); pg.wait_for_timeout(300); shot(pg,'49_admin_results',True)
    pg.click('.sus .btn--danger >> nth=0'); pg.wait_for_timeout(900); print('exclude toast:', pg.locator('.toast').all_inner_texts())
    pg.click('.tab >> text=Рисунки'); pg.wait_for_selector('.gal'); pg.wait_for_timeout(300); shot(pg,'50_admin_drawings')
    pg.click('.tab >> text=Форум'); pg.wait_for_selector('.post'); shot(pg,'51_admin_forum')
    # 4. Пользователь на ПК
    print(errors)
    b.close()
